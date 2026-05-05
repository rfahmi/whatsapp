require('dotenv').config();

// Ultimate silence: Intercept system-level output to filter out noisy library blobs
const originalWrite = process.stdout.write;
process.stdout.write = function(chunk, encoding, callback) {
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
const { connectToWhatsApp } = require('./lib/whatsapp');
const { addMessageToQueue, startQueueWorker } = require('./lib/queue');
const { authMiddleware } = require('./middleware/auth');
const logger = require('./lib/logger');
const { startHousekeeping } = require('./lib/housekeeping');
const { db } = require('./lib/firestore');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.post('/send-message', authMiddleware, async (req, res) => {
    const { to, message, buttons, footer } = req.body;

    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" fields' });
    }

    // Append @s.whatsapp.net if not present
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    try {
        const payload = (buttons && Array.isArray(buttons)) 
            ? { message, buttons, footer } 
            : message;

        const messageId = await addMessageToQueue(jid, payload);
        res.status(202).json({ status: 'queued', messageId });
    } catch (error) {
        logger.error({ err: error.message }, 'Error queuing message');
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Securely reset the session remotely (useful for Cloud Run)
app.post('/reset-session', authMiddleware, async (req, res) => {
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
    try {
        await connectToWhatsApp();
        startQueueWorker();
        startHousekeeping();
        app.listen(PORT, () => {
            logger.info(`Service running on port ${PORT}`);
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to start service');
        process.exit(1);
    }
};

start();
