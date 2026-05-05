require('dotenv').config();

// Ultimate silence: Intercept system-level output to filter out noisy library blobs
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, callback) {
    const str = chunk.toString();
    if (str.includes('Closing session')) return true;
    return originalWrite.apply(process.stdout, arguments);
};

const originalLog = console.log;
console.log = (...args) => {
    const msg = args[0];
    if (typeof msg === 'string' && msg.includes('Closing session')) return;
    originalLog(...args);
};

const express = require('express');
const { authMiddleware } = require('./middleware/auth');
const logger = require('./lib/logger');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Lazy-loaded services
let db;
let addMessageToQueue;
let startQueueWorker;
let connectToWhatsApp;
let startHousekeeping;
let getQr;

app.post('/send-message', authMiddleware, async (req, res) => {
    if (!addMessageToQueue) {
        ({ addMessageToQueue } = require('./lib/queue'));
    }
    const { to, message, buttons, footer, header } = req.body;

    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" fields' });
    }

    // Append @s.whatsapp.net if not present
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    try {
        const payload = message;
        const messageId = await addMessageToQueue(jid, payload);
        res.status(202).json({ status: 'queued', messageId });
    } catch (error) {
        logger.error({ err: error.message }, 'Error queuing message');
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/qr', authMiddleware, async (req, res) => {
    if (!getQr) {
        ({ getQr } = require('./lib/whatsapp'));
    }
    if (!db) {
        ({ db } = require('./lib/firestore'));
    }
    const sessionId = process.env.NODE_ENV === 'production' ? 'main-session' : 'local-test-session';

    try {
        // Try memory first, then Firestore
        let qr = getQr();
        if (!qr) {
            const doc = await db.collection('whatsapp_sessions').doc(sessionId).get();
            qr = doc.data()?.lastQr;
        }

        if (!qr) {
            return res.status(404).send('No active QR code found. Is it already connected?');
        }

        if (req.query.format === 'json') {
            return res.json({ qr });
        }

        // Simple HTML to render QR
        res.send(`
            <html>
                <head><title>WhatsApp QR</title></head>
                <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background:#f0f2f5;">
                    <div style="background:white; padding:40px; border-radius:20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align:center;">
                        <h1 style="color:#128c7e;">Scan WhatsApp QR</h1>
                        <div id="qrcode" style="margin:20px 0;"></div>
                        <p style="color:#666;">Refresh this page if the QR expires.</p>
                    </div>
                    <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
                    <script>
                        new QRCode(document.getElementById("qrcode"), {
                            text: "${qr}",
                            width: 256,
                            height: 256
                        });
                    </script>
                </body>
            </html>
        `);
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to fetch QR');
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Securely reset the session remotely (useful for Cloud Run)
app.post('/reset-session', authMiddleware, async (req, res) => {
    if (!db) {
        ({ db } = require('./lib/firestore'));
    }
    const sessionId = process.env.NODE_ENV === 'production' ? 'main-session' : 'local-test-session';
    logger.warn({ sessionId }, 'Manual session reset triggered via API');

    try {
        // 1. Delete session from Firestore
        await db.collection('whatsapp_sessions').doc(sessionId).delete();

        // 2. Also delete all keys in the subcollection
        const keysSnapshot = await db.collection('whatsapp_sessions').doc(sessionId).collection('keys').get();
        const batch = db.batch();
        keysSnapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();

        res.json({ status: 'success', message: 'Session cleared. Service will restart to show new QR code.' });

        // 3. Exit process (Cloud Run will restart it automatically)
        setTimeout(() => process.exit(0), 1000);
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to reset session');
        res.status(500).json({ error: 'Failed to reset session' });
    }
});

const start = async () => {
    app.listen(PORT, async () => {
        logger.info(`Service running on port ${PORT}`);
        try {
            // Load background services lazily
            ({ connectToWhatsApp, getQr } = require('./lib/whatsapp'));
            ({ startQueueWorker } = require('./lib/queue'));
            ({ startHousekeeping } = require('./lib/housekeeping'));
            ({ db } = require('./lib/firestore'));

            await connectToWhatsApp();
            startQueueWorker();
            startHousekeeping();
            logger.info('Background services initialized');
        } catch (error) {
            logger.error({ err: error.message }, 'Failed to initialize background services');
        }
    });
};

start();
