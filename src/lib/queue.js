const { db } = require('./firestore');
const { sendMessage } = require('./whatsapp');
const logger = require('./logger');

const addMessageToQueue = async (to, message) => {
    const docRef = db.collection('messages').doc();
    await docRef.set({
        to,
        message,
        status: 'pending',
        createdAt: new Date(),
        retries: 0
    });
    return docRef.id;
};

const processQueue = async () => {
    try {
        const messagesRef = db.collection('messages');
        
        // 1. Recover stuck messages (status='processing' and processingAt < 2 mins ago)
        // We filter in memory to avoid needing another composite index
        const stuckSnapshot = await messagesRef.where('status', '==', 'processing').get();
        const stuckTimeout = Date.now() - 2 * 60 * 1000;
        
        for (const doc of stuckSnapshot.docs) {
            const data = doc.data();
            const processingAt = data.processingAt?.toDate?.()?.getTime() || 0;
            if (processingAt < stuckTimeout) {
                logger.warn({ messageId: doc.id }, 'Recovering stuck message');
                await doc.ref.update({ status: 'failed', lastError: 'Timeout/Stuck' });
            }
        }

        // 2. Fetch new messages to process
        const query = messagesRef.where('status', 'in', ['pending', 'failed'])
            .where('retries', '<', 3)
            .limit(10);

        const snapshot = await query.get();

        if (snapshot.empty) return;

        for (const doc of snapshot.docs) {
            const success = await db.runTransaction(async (transaction) => {
                const messageDoc = await transaction.get(doc.ref);
                const data = messageDoc.data();

                if (data.status === 'pending' || data.status === 'failed') {
                    transaction.update(doc.ref, { 
                        status: 'processing', 
                        processingAt: new Date(),
                        retries: data.retries + 1
                    });
                    return true;
                }
                return false;
            });

            if (!success) continue;

            const data = doc.data();
            logger.info({ messageId: doc.id, to: data.to }, 'Processing message');
            try {
                await sendMessage(data.to, data.message);
                await doc.ref.update({ status: 'sent', sentAt: new Date() });
                logger.info({ messageId: doc.id }, 'Message sent successfully');
            } catch (error) {
                logger.error({ messageId: doc.id, err: error.message }, 'Failed to send message');
                await doc.ref.update({ status: 'failed', lastError: error.message });
            }
        }
    } catch (error) {
        logger.error({ err: error.message }, 'Error in processQueue');
    }
};

const startQueueWorker = () => {
    logger.info('Queue worker started');
    setInterval(processQueue, 5000); // Check every 5 seconds
};

module.exports = { addMessageToQueue, startQueueWorker };
