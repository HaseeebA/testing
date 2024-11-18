const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs-extra');

const app = express();
app.use(express.json());

// Store active client instances
const activeClients = new Map();
// Store active client instances

// Session directory path
const SESSION_PATH = path.join(process.cwd(), '.wapp-sessions');

// Ensure session directory exists
fs.ensureDirSync(SESSION_PATH);

// Add this near the top of your file after other middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve a simple test page
app.get('/test-whatsapp/:uid', (req, res) => {
    res.render('whatsapp-test', { uid: req.params.uid });
});

// Rest of your existing code...
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

// Modify the /init endpoint to handle HTML response
app.post('/init', authMiddleware, async (req, res) => {
    const { uid } = req;
    const isHtml = req.headers.accept?.includes('text/html');
    
    try {
        let clientState = activeClients.get(uid);
        
        if (!clientState || clientState.status === 'disconnected') {
            clientState = await initializeClient(uid);
        }

        if (isHtml) {
            res.json({
                status: clientState.status,
                qrCode: clientState.qrCode
            });
        } else {
            res.json({
                status: clientState.status,
                qrCode: clientState.qrCode
            });
        }
    } catch (error) {
        const response = {
            status: 'error',
            message: 'Failed to initialize WhatsApp client',
            error: error.message
        };
        
        if (isHtml) {
            res.status(500).json(response);
        } else {
            res.status(500).json(response);
        }
    }
});

// Add a status check endpoint that includes QR code
app.get('/client-status/:uid', async (req, res) => {
    const uid = req.params.uid;
    const clientState = activeClients.get(uid);

    if (!clientState) {
        return res.json({ status: 'not_initialized' });
    }

    res.json({
        status: clientState.status,
        qrCode: clientState.qrCode,
        lastActivity: clientState.lastActivity
    });
});

// Your existing code continues...

// Session directory path

// Ensure session directory exists
fs.ensureDirSync(SESSION_PATH);

// Middleware to check authorization


// Initialize a new WhatsApp client for a user
async function initializeClient(uid) {
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

    // Store client state
    const clientState = {
        client,
        status: 'initializing',
        qrCode: null,
        lastActivity: Date.now()
    };
    
    activeClients.set(uid, clientState);

    // Handle QR code generation
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

    // Handle authentication
    client.on('authenticated', () => {
        console.log('Authenticated successfully for', uid);
        clientState.status = 'authenticated';
        clientState.qrCode = null;
    });

    // Handle ready state
    client.on('ready', () => {
        console.log('WhatsApp client is ready for', uid);
        clientState.status = 'ready';
        clientState.lastActivity = Date.now();
    });

    // Handle disconnection
    client.on('disconnected', async () => {
        clientState.status = 'disconnected';
        await cleanupSession(uid);
    });

    try {
        await client.initialize();
        return clientState;
    } catch (error) {
        console.error(`Error initializing client for ${uid}:`, error);
        await cleanupSession(uid);
        throw error;
    }
}

// Cleanup session files
async function cleanupSession(uid) {
    const userSessionPath = path.join(SESSION_PATH, uid);
    try {
        if (await fs.pathExists(userSessionPath)) {
            await fs.remove(userSessionPath);
        }
        activeClients.delete(uid);
    } catch (error) {
        console.error(`Error cleaning up session for ${uid}:`, error);
    }
}

// // Initialize WhatsApp connection
// app.post('/init', authMiddleware, async (req, res) => {
//     const { uid } = req;
    
//     try {
//         let clientState = activeClients.get(uid);
        
//         if (!clientState || clientState.status === 'disconnected') {
//             clientState = await initializeClient(uid);
//         }

//         res.json({
//             status: clientState.status,
//             qrCode: clientState.qrCode
//         });
//     } catch (error) {
//         res.status(500).json({
//             status: 'error',
//             message: 'Failed to initialize WhatsApp client',
//             error: error.message
//         });
//     }
// });

// Send message endpoint
app.post('/send-message', authMiddleware, async (req, res) => {
    const { uid } = req;
    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({
            status: 'error',
            message: 'Phone number and message are required'
        });
    }

    try {
        const clientState = activeClients.get(uid);
        if (!clientState || clientState.status !== 'ready') {
            return res.status(400).json({
                status: 'error',
                message: 'WhatsApp client not ready. Please initialize first.'
            });
        }

        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        await clientState.client.sendMessage(chatId, message);
        clientState.lastActivity = Date.now();

        res.json({
            status: 'success',
            message: 'Message sent successfully'
        });
    } catch (error) {
        console.error(`Error sending message for ${uid}:`, error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to send message',
            error: error.message
        });
    }
});

// Get client status endpoint
app.get('/status', authMiddleware, (req, res) => {
    const { uid } = req;
    const clientState = activeClients.get(uid);

    if (!clientState) {
        return res.json({ status: 'not_initialized' });
    }

    res.json({
        status: clientState.status,
        lastActivity: clientState.lastActivity
    });
});

// Cleanup inactive sessions periodically (every hour)
setInterval(async () => {
    const inactivityThreshold = 3600000; // 1 hour
    const now = Date.now();

    for (const [uid, clientState] of activeClients.entries()) {
        if (now - clientState.lastActivity > inactivityThreshold) {
            console.log(`Cleaning up inactive session for ${uid}`);
            await cleanupSession(uid);
        }
    }
}, 36000);

// Handle server shutdown
process.on('SIGTERM', async () => {
    console.log('Server shutting down, cleaning up sessions...');
    for (const [uid, clientState] of activeClients.entries()) {
        await clientState.client.destroy();
        await cleanupSession(uid);
    }
    process.exit(0);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp Server running on port ${PORT}`);
});