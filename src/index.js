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

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.post('/send-message', authMiddleware, async (req, res) => {
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" fields' });
    }

    // Append @s.whatsapp.net if not present
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    try {
        const messageId = await addMessageToQueue(jid, message);
        res.status(202).json({ status: 'queued', messageId });
    } catch (error) {
        logger.error({ err: error.message }, 'Error queuing message');
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
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
