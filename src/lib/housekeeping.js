const { db } = require('./firestore');
const logger = require('./logger');

/**
 * Deletes old messages and stale data from Firestore
 */
const runHousekeeping = async () => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    logger.info('Starting housekeeping job...');

    try {
        // 1. Cleanup old messages (sent or failed)
        const messagesRef = db.collection('messages');
        const oldMessagesQuery = messagesRef
            .where('createdAt', '<', sevenDaysAgo)
            .limit(500); // Process in batches

        const snapshot = await oldMessagesQuery.get();
        
        if (snapshot.empty) {
            logger.info('No old messages to clean up.');
        } else {
            const batch = db.batch();
            snapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            logger.info({ count: snapshot.size }, 'Cleaned up old messages');
        }

        // Add other cleanup tasks here (e.g. temporary logs, etc.)

    } catch (error) {
        logger.error({ err: error.message }, 'Housekeeping job failed');
    }
};

/**
 * Starts the housekeeping scheduler (runs once every 24 hours)
 */
const startHousekeeping = () => {
    // Run immediately on start
    runHousekeeping();
    
    // Then run every 24 hours
    setInterval(runHousekeeping, 24 * 60 * 60 * 1000);
};

module.exports = { startHousekeeping };
