const { db } = require('./firestore');
const { sendMessage } = require('./whatsapp');

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
        const query = messagesRef.where('status', 'in', ['pending', 'failed'])
            .where('retries', '<', 3)
            .limit(10);

        const snapshot = await query.get();

        if (snapshot.empty) return;

        for (const doc of snapshot.docs) {
            await db.runTransaction(async (transaction) => {
                const messageDoc = await transaction.get(doc.ref);
                const data = messageDoc.data();

                if (data.status === 'pending' || data.status === 'failed') {
                    // Claim the message
                    transaction.update(doc.ref, { 
                        status: 'processing', 
                        processingAt: new Date(),
                        retries: data.retries + 1
                    });

                    // We execute the sending OUTSIDE the transaction if we want to avoid long locks,
                    // but since we updated status to 'processing', other instances won't pick it up.
                }
            });

            // Now send it
            const data = doc.data();
            try {
                await sendMessage(data.to, data.message);
                await doc.ref.update({ status: 'sent', sentAt: new Date() });
            } catch (error) {
                console.error(`Failed to send message ${doc.id}:`, error);
                await doc.ref.update({ status: 'failed', lastError: error.message });
            }
        }
    } catch (error) {
        console.error('Error in processQueue:', error);
    }
};

const startQueueWorker = () => {
    console.log('Queue worker started');
    setInterval(processQueue, 5000); // Check every 5 seconds
};

module.exports = { addMessageToQueue, startQueueWorker };
