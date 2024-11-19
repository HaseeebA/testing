const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs-extra');

const app = express();
app.use(express.json());

const MAX_INSTANCES = 2;
const INACTIVITY_TIMEOUT = 300000; // 5 minutes
const SESSION_PATH = path.join(process.cwd(), '.wapp-sessions');

// Store active clients with their ready states
const activeClients = new Map();

// Ensure session directory exists
fs.ensureDirSync(SESSION_PATH);

const authMiddleware = (req, res, next) => {
    const uid = req.headers.authorization?.split(' ')[1];
    if (!uid) {
        return res.status(401).json({
            status: 'error',
            message: 'Authorization token required'
        });
    }
    req.uid = uid;
    next();
};

// Safe cleanup function with retries
async function safeCleanup(path, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await fs.remove(path);
            return true;
        } catch (error) {
            if (i === maxRetries - 1) {
                throw error;
            }
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return false;
}

async function cleanupSession(uid) {
    const clientState = activeClients.get(uid);
    if (clientState) {
        try {
            // First destroy the client and wait a bit
            if (clientState.client) {
                try {
                    await clientState.client.destroy();
                } catch (e) {
                    console.error('Error destroying client:', e);
                }
                // Wait for browser to fully close
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            console.error('Error during client destroy:', error);
        }
    }

    // Then remove from active clients
    activeClients.delete(uid);

    // Finally clean up session files
    // const userSessionPath = path.join(SESSION_PATH, uid);
    try {
        // await safeCleanup(userSessionPath);
    } catch (error) {
        console.error(`Error cleaning up session for ${uid}:`, error);
        // Don't throw, just log
    }
}

// Initialize a new WhatsApp client for a user
async function initializeClient(uid, retryCount = 0) {
    const MAX_RETRIES = 2;
    
    try {
        // Check if there's an existing client
        const existingClient = activeClients.get(uid);
        if (existingClient) {
            console.log(`Existing client found for ${uid}:`, existingClient.status);
            if (existingClient.status === 'ready') {
                return existingClient;
            }
            // If not ready, clean it up
            // await cleanupSession(uid);
            if (['disconnected', 'error'].includes(existingClient.status)) {
                await cleanupSession(uid);
            }
        }

        // Check instance limit
        if (activeClients.size >= MAX_INSTANCES) {
            // Find oldest client
            let oldestClient = null;
            let oldestTime = Date.now();
            
            for (const [clientUid, state] of activeClients.entries()) {
                if (state.lastActivity < oldestTime) {
                    oldestTime = state.lastActivity;
                    oldestClient = clientUid;
                }
            }
            
            if (oldestClient) {
                await cleanupSession(oldestClient);
            }
        }

        // Ensure clean session directory
        const userSessionPath = path.join(SESSION_PATH, uid);
        const sessionExists = await fs.pathExists(userSessionPath);
        if (!sessionExists) {
            await fs.ensureDir(userSessionPath);
        }

        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: uid,
                dataPath: userSessionPath
            }),
            puppeteer: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu',
                ],
                // userDataDir: path.join(userSessionPath, 'browser_data'),
                headless: true
            }
        });

        let readyResolve, readyReject;
        const readyPromise = new Promise((resolve, reject) => {
            readyResolve = resolve;
            readyReject = reject;
        });

        const clientState = {
            client,
            status: sessionExists ? 'resuming' : 'initializing',
            qrCode: null,
            lastActivity: Date.now(),
            readyPromise,
            readyResolve,
            readyReject
        };

        // Set up event handlers
        const initTimeout = setTimeout(async () => {
            clientState.readyReject(new Error('Client initialization timeout'));
            await cleanupSession(uid);
        }, 150000); // 45 second timeout

        client.on('qr', async (qr) => {
            try {
                console.log('QR received for', uid);
                const qrDataUrl = await QRCode.toDataURL(qr);
                clientState.qrCode = qrDataUrl;
                clientState.status = 'pending';
            } catch (error) {
                console.error(`Error generating QR for ${uid}:`, error);
            }
        });

        client.on('authenticated', () => {
            console.log('Authenticated successfully for', uid);
            clientState.status = 'authenticated';
            clientState.qrCode = null;
        });

        client.on('ready', () => {
            console.log('WhatsApp client is ready for', uid);
            clientState.status = 'ready';
            clientState.lastActivity = Date.now();
            clearTimeout(initTimeout);
            clientState.readyResolve(clientState);
        });

        client.on('disconnected', async () => {
            console.log('Client disconnected:', uid);
            clientState.status = 'disconnected';
            clearTimeout(initTimeout);
            activeClients.delete(uid);
        });

        // Store client state before initialization
        activeClients.set(uid, clientState);

        // Initialize the client
        console.log(`${sessionExists ? 'Resuming' : 'Initializing'} client for ${uid}...`);
        await client.initialize();
        console.log('Client initialized for', uid);

        // Wait for ready state
        return await readyPromise;

    } catch (error) {
        console.error(`Error initializing client for ${uid}:`, error);
        // Don't clean up session on error to allow resuming
        activeClients.delete(uid);
        
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying initialization for ${uid}, attempt ${retryCount + 1}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return initializeClient(uid, retryCount + 1);
        }
        
        throw error;
    }
}

// Send message endpoint
app.post('/send-message', authMiddleware, async (req, res) => {
    const { uid } = req;
    const { number, message } = req.body;
    console.log(number, message);

    try {
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        
        let clientState = await initializeClient(uid);
        
        // Extra verification of client state
        if (!clientState || clientState.status !== 'ready') {
            throw new Error('Client not ready');
        }

        // Send message
        await clientState.client.sendMessage(chatId, message);
        clientState.lastActivity = Date.now();
    
        res.json({
            status: 'success',
            message: 'Message sent successfully'
        });
    } catch (error) {
        console.error(`Error sending message for ${uid}:`, error);
        
        // Cleanup on error
        await cleanupSession(uid);
        
        res.status(500).json({
            status: 'error',
            message: 'Failed to send message',
            error: error.message
        });
    }
});

// Rest of the endpoints remain the same...
app.get('/client-status/:uid', async (req, res) => {
    const uid = req.params.uid;
    const clientState = activeClients.get(uid);

    if (!clientState) {
        return res.json({ status: 'disconnected' });
    }

    res.json({
        status: clientState.status,
        qrCode: clientState.qrCode,
        lastActivity: clientState.lastActivity
    });
});

// Disconnect endpoint
app.post('/disconnect', authMiddleware, async (req, res) => {
    const { uid } = req;
    const clientState = activeClients.get(uid);

    if (clientState) {
        try {
            await clientState.client.destroy();
            await cleanupSession(uid);
            res.json({ status: 'disconnected' });
        } catch (error) {
            res.status(500).json({
                status: 'error',
                message: 'Failed to disconnect',
                error: error.message
            });
        }
    } else {
        res.json({ status: 'disconnected' });
    }
});

app.post('/init', authMiddleware, async (req, res) => {
    const { uid } = req;
    
    try {
        let clientState = activeClients.get(uid);
        if (!clientState || clientState.status === 'disconnected') {
            clientState = await initializeClient(uid);
        }

        res.json({
            status: clientState.status,
            qrCode: clientState.qrCode
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Failed to initialize WhatsApp client',
            error: error.message
        });
    }
});
// Modified cleanup interval
setInterval(async () => {
    console.log('Checking for inactive sessions...');
    const now = Date.now();

    for (const [uid, clientState] of activeClients.entries()) {
        if (now - clientState.lastActivity > INACTIVITY_TIMEOUT) {
            console.log(`Cleaning up inactive session for ${uid}`);
            await cleanupSession(uid);
        }
    }
}, 60000);

// Handle process termination
process.on('SIGTERM', async () => {
    console.log('Server shutting down, cleaning up sessions...');
    for (const [uid] of activeClients.entries()) {
        await cleanupSession(uid);
    }
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    // Cleanup all sessions on uncaught exception
    for (const [uid] of activeClients.entries()) {
        await cleanupSession(uid);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp Server running on port ${PORT}`);
});