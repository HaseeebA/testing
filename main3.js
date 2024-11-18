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

// Enhanced client management
const activeClients = new Map(); // Stores active WhatsApp clients
const clientPool = new Map();    // Stores the actual browser instances
const userSessions = new Map();  // Maps users to their session data

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

// Session management functions
async function saveSession(uid) {
    const sessionPath = path.join(SESSION_PATH, uid, 'session.json');
    const clientState = activeClients.get(uid);
    if (clientState && clientState.client) {
        try {
            const sessionData = {
                lastActive: Date.now(),
                authenticated: clientState.status === 'ready'
            };
            await fs.writeJson(sessionPath, sessionData);
            userSessions.set(uid, sessionData);
            console.log(`Session saved for ${uid}`);
        } catch (error) {
            console.error(`Error saving session for ${uid}:`, error);
        }
    }
}

async function loadSession(uid) {
    const sessionPath = path.join(SESSION_PATH, uid, 'session.json');
    try {
        if (await fs.pathExists(sessionPath)) {
            const sessionData = await fs.readJson(sessionPath);
            userSessions.set(uid, sessionData);
            console.log(`Session loaded for ${uid}`);
            return sessionData;
        }
    } catch (error) {
        console.error(`Error loading session for ${uid}:`, error);
    }
    return null;
}

// Get or create a client instance from the pool
async function getClientInstance() {
    // Find least busy instance or create new one
    let selectedInstance = null;
    let minUsers = Infinity;

    for (const [instance, users] of clientPool.entries()) {
        if (users.size < minUsers) {
            selectedInstance = instance;
            minUsers = users.size;
        }
    }

    if (!selectedInstance && clientPool.size < MAX_INSTANCES) {
        selectedInstance = Symbol('instance');
        clientPool.set(selectedInstance, new Set());
        console.log('Created new client instance:', clientPool.size);
    }

    return selectedInstance;
}

async function cleanupSession(uid) {
    console.log(`Cleaning up session for ${uid}`);
    const clientState = activeClients.get(uid);
    
    if (clientState) {
        // Save session before cleanup
        await saveSession(uid);
        
        // Remove user from instance pool
        for (const [instance, users] of clientPool.entries()) {
            if (users.has(uid)) {
                users.delete(uid);
                console.log(`Removed ${uid} from instance pool`);
                break;
            }
        }

        try {
            if (clientState.client) {
                await clientState.client.destroy();
                console.log(`Client destroyed for ${uid}`);
            }
        } catch (error) {
            console.error(`Error destroying client for ${uid}:`, error);
        }

        activeClients.delete(uid);
    }
}

async function initializeClient(uid, retryCount = 0) {
    const MAX_RETRIES = 2;
    
    try {
        // Check existing session
        const existingClient = activeClients.get(uid);
        if (existingClient && existingClient.status === 'ready') {
            console.log(`Reusing existing client for ${uid}`);
            return existingClient;
        }

        // Load saved session
        const savedSession = await loadSession(uid);
        console.log(`Session status for ${uid}:`, savedSession?.authenticated);

        // Get instance from pool
        const instance = await getClientInstance();
        if (!instance) {
            throw new Error('No available client instances');
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

        let readyResolve, readyReject;
        const readyPromise = new Promise((resolve, reject) => {
            readyResolve = resolve;
            readyReject = reject;
        });

        const clientState = {
            client,
            status: savedSession?.authenticated ? 'resuming' : 'initializing',
            qrCode: null,
            lastActivity: Date.now(),
            readyPromise,
            readyResolve,
            readyReject,
            instance
        };

        const initTimeout = setTimeout(async () => {
            clientState.readyReject(new Error('Client initialization timeout'));
            await cleanupSession(uid);
        }, 150000);

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
            saveSession(uid);
        });

        client.on('ready', () => {
            console.log('WhatsApp client is ready for', uid);
            clientState.status = 'ready';
            clientState.lastActivity = Date.now();
            clearTimeout(initTimeout);
            clientState.readyResolve(clientState);
            
            // Add user to instance pool
            clientPool.get(instance).add(uid);
        });

        client.on('disconnected', async () => {
            console.log('Client disconnected:', uid);
            clientState.status = 'disconnected';
            clearTimeout(initTimeout);
            await cleanupSession(uid);
        });

        activeClients.set(uid, clientState);
        console.log(`Initializing client for ${uid}...`);
        await client.initialize();
        console.log('Client initialized for', uid);

        return await readyPromise;

    } catch (error) {
        console.error(`Error initializing client for ${uid}:`, error);
        activeClients.delete(uid);
        
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying initialization for ${uid}, attempt ${retryCount + 1}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return initializeClient(uid, retryCount + 1);
        }
        
        throw error;
    }
}

// Enhanced message sending with session management
app.post('/send-message', authMiddleware, async (req, res) => {
    const { uid } = req;
    const { number, message } = req.body;
    console.log(`Sending message for ${uid} to ${number}`);

    try {
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        
        let clientState = await initializeClient(uid);
        
        if (!clientState || clientState.status !== 'ready') {
            throw new Error('Client not ready');
        }

        await clientState.client.sendMessage(chatId, message);
        clientState.lastActivity = Date.now();
        
        // Update session
        await saveSession(uid);
    
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

app.get('/client-status/:uid', async (req, res) => {
    const uid = req.params.uid;
    const clientState = activeClients.get(uid);
    const sessionData = userSessions.get(uid);

    if (!clientState && !sessionData) {
        return res.json({ status: 'disconnected' });
    }

    res.json({
        status: clientState?.status || 'inactive',
        qrCode: clientState?.qrCode,
        lastActivity: clientState?.lastActivity || sessionData?.lastActive,
        authenticated: sessionData?.authenticated || false
    });
});

app.post('/disconnect', authMiddleware, async (req, res) => {
    const { uid } = req;
    
    try {
        await cleanupSession(uid);
        res.json({ status: 'disconnected' });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Failed to disconnect',
            error: error.message
        });
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
            qrCode: clientState.qrCode,
            authenticated: userSessions.get(uid)?.authenticated || false
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
    console.log('Running cleanup check...');
    console.log('Active instances:', clientPool.size);
    console.log('Active clients:', activeClients.size);
    
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
    console.log('Server shutting down...');
    for (const [uid] of activeClients.entries()) {
        await cleanupSession(uid);
    }
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    for (const [uid] of activeClients.entries()) {
        await cleanupSession(uid);
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp Server running on port ${PORT}`);
    console.log(`Max instances: ${MAX_INSTANCES}`);
});