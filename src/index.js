require('dotenv').config();
const express = require('express');
const { connectToWhatsApp } = require('./lib/whatsapp');
const { addMessageToQueue, startQueueWorker } = require('./lib/queue');
const { authMiddleware } = require('./middleware/auth');

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
        console.error('Error queuing message:', error);
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
        app.listen(PORT, () => {
            console.log(`Service running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start service:', error);
        process.exit(1);
    }
};

start();
