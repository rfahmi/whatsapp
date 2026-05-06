require('dotenv').config();
const { db } = require('./lib/firestore');

async function retryAll() {
    console.log('Resetting failed messages for retry...');
    const snapshot = await db.collection('messages')
        .where('status', '==', 'failed')
        .get();

    if (snapshot.empty) {
        console.log('No failed messages found.');
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach(doc => {
        batch.update(doc.ref, {
            status: 'pending',
            retries: 0,
            nextRetryAt: new Date(),
            lastError: null
        });
    });

    await batch.commit();
    console.log(`Reset ${snapshot.size} messages. They will be picked up by the worker shortly.`);
}

retryAll().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
