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
const CONNECTION_QUEUE = [];
const QUEUE_CHECK_INTERVAL = 5000;

// Enhanced session store with actual browser state
const sessionStore = new Map(); // Structure: uid -> { state, page, browser, lastAccess }
const activeClients = new Map();

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
let isProcessingQueue = false;
async function processQueue() {
    if (isProcessingQueue || CONNECTION_QUEUE.length === 0) return;
    
    isProcessingQueue = true;
    
    try {
        while (CONNECTION_QUEUE.length > 0) {
            // Check if we can create a new instance
            if (activeClients.size >= MAX_INSTANCES) {
                // Find idle clients that can be recycled
                const now = Date.now();
                let oldestClient = null;
                let oldestTime = now;
                
                for (const [uid, state] of activeClients.entries()) {
                    if (state.lastActivity < oldestTime && state.status === 'ready') {
                        oldestTime = state.lastActivity;
                        oldestClient = uid;
                    }
                }
                
                if (oldestClient && (now - oldestTime > INACTIVITY_TIMEOUT)) {
                    await cleanupSession(oldestClient);
                } else {
                    break; // No available slots
                }
            }
            
            const { uid, resolve, reject } = CONNECTION_QUEUE.shift();
            try {
                const clientState = await initializeClient(uid);
                resolve(clientState);
            } catch (error) {
                reject(error);
            }
        }
    } finally {
        isProcessingQueue = false;
    }
}

async function preserveSession(uid, client) {
    try {
        // Get the current page and browser instance from puppeteer
        const page = await client.pupPage;
        const browser = page.browser();

        // Store cookies and local storage
        const cookies = await page.cookies();
        const localStorage = await page.evaluate(() => {
            const items = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                items[key] = localStorage.getItem(key);
            }
            return items;
        });

        // Save the session state
        sessionStore.set(uid, {
            cookies,
            localStorage,
            lastAccess: Date.now()
        });

        console.log(`Session preserved for ${uid}`);
        return true;
    } catch (error) {
        console.error(`Failed to preserve session for ${uid}:`, error);
        return false;
    }
}

async function restoreSession(uid, page) {
    const session = sessionStore.get(uid);
    if (!session) return false;

    try {
        // Restore cookies
        await page.setCookie(...session.cookies);

        // Restore localStorage
        await page.evaluate((storageItems) => {
            localStorage.clear();
            for (const [key, value] of Object.entries(storageItems)) {
                localStorage.setItem(key, value);
            }
        }, session.localStorage);

        console.log(`Session restored for ${uid}`);
        return true;
    } catch (error) {
        console.error(`Failed to restore session for ${uid}:`, error);
        return false;
    }
}

async function initializeClient(uid) {
    // Check for existing active client
    const existingClient = activeClients.get(uid);
    if (existingClient?.status === 'ready') {
        existingClient.lastActivity = Date.now();
        return existingClient;
    }

    // Queue if at capacity
    if (activeClients.size >= MAX_INSTANCES) {
        return new Promise((resolve, reject) => {
            CONNECTION_QUEUE.push({ uid, resolve, reject });
        });
    }

    const userSessionPath = path.join(SESSION_PATH, uid);
    await fs.ensureDir(userSessionPath);

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
                '--disable-gpu'
            ],
            headless: true
        }
    });

    const clientState = {
        client,
        status: 'initializing',
        qrCode: null,
        lastActivity: Date.now(),
        readyPromise: null
    };

    clientState.readyPromise = new Promise((resolve, reject) => {
        const initTimeout = setTimeout(() => {
            reject(new Error('Client initialization timeout'));
            cleanupSession(uid);
        }, 45000);

        client.on('qr', async (qr) => {
            console.log(`QR Code generated for ${uid}`);
            clientState.qrCode = await QRCode.toDataURL(qr);
            clientState.status = 'pending';
        });

        client.on('authenticated', async () => {
            clientState.status = 'authenticated';
            clientState.qrCode = null;
            
            // Save session state after authentication
            const page = await client.pupPage;
            if (page) {
                await preserveSession(uid, client);
            }
        });

        client.on('ready', () => {
            clearTimeout(initTimeout);
            clientState.status = 'ready';
            clientState.lastActivity = Date.now();
            resolve(clientState);
        });

        // Enhanced connection handling
        client.on('disconnected', async () => {
            clientState.status = 'disconnected';
            
            // Try to preserve session before cleanup
            try {
                await preserveSession(uid, client);
            } catch (error) {
                console.error(`Failed to preserve session for ${uid}:`, error);
            }
            
            await cleanupSession(uid);
        });
    });

    // Setup browser hooks
    client.on('load', async () => {
        const page = await client.pupPage;
        if (page) {
            // Attempt to restore session
            const restored = await restoreSession(uid, page);
            if (restored) {
                console.log(`Session restored successfully for ${uid}`);
            }
        }
    });

    activeClients.set(uid, clientState);
    await client.initialize();
    
    return clientState.readyPromise;
}

async function cleanupSession(uid) {
    const clientState = activeClients.get(uid);
    if (clientState) {
        try {
            // Preserve session before cleanup if client is in good state
            if (clientState.status === 'ready' || clientState.status === 'authenticated') {
                await preserveSession(uid, clientState.client);
            }

            await clientState.client.destroy();
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error('Error during client cleanup:', error);
        }
        
        activeClients.delete(uid);
    }
}

// Message sending endpoint with session management
app.post('/send-message', authMiddleware, async (req, res) => {
    const { uid } = req;
    const { number, message } = req.body;

    try {
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        let clientState = await initializeClient(uid);

        if (!clientState || clientState.status !== 'ready') {
            throw new Error('Client not ready');
        }

        await clientState.client.sendMessage(chatId, message);
        clientState.lastActivity = Date.now();

        // Update session after successful message
        await preserveSession(uid, clientState.client);

        res.json({
            status: 'success',
            message: 'Message sent successfully'
        });
    } catch (error) {
        console.error(`Error sending message for ${uid}:`, error);
        await cleanupSession(uid);
        
        res.status(500).json({
            status: 'error',
            message: 'Failed to send message',
            error: error.message
        });
    }
});

// Add endpoint to force session preservation
app.post('/preserve-session', authMiddleware, async (req, res) => {
    const { uid } = req;
    const clientState = activeClients.get(uid);

    if (!clientState || clientState.status !== 'ready') {
        return res.status(400).json({
            status: 'error',
            message: 'No active client to preserve'
        });
    }

    try {
        await preserveSession(uid, clientState.client);
        res.json({
            status: 'success',
            message: 'Session preserved successfully'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Failed to preserve session',
            error: error.message
        });
    }
});

// Process queue periodically
setInterval(processQueue, QUEUE_CHECK_INTERVAL);

// // Send message endpoint
// app.post('/send-message', authMiddleware, async (req, res) => {
//     const { uid } = req;
//     const { number, message } = req.body;
//     console.log(number, message);

//     try {
//         const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        
//         let clientState = await initializeClient(uid);
        
//         // Extra verification of client state
//         if (!clientState || clientState.status !== 'ready') {
//             throw new Error('Client not ready');
//         }

//         // Send message
//         await clientState.client.sendMessage(chatId, message);
//         clientState.lastActivity = Date.now();
    
//         res.json({
//             status: 'success',
//             message: 'Message sent successfully'
//         });
//     } catch (error) {
//         console.error(`Error sending message for ${uid}:`, error);
        
//         // Cleanup on error
//         await cleanupSession(uid);
        
//         res.status(500).json({
//             status: 'error',
//             message: 'Failed to send message',
//             error: error.message
//         });
//     }
// });

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp Server running on port ${PORT}`);
});