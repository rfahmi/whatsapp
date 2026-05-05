require('dotenv').config();
const { db } = require('./lib/firestore');

async function reset(sessionId) {
    console.log(`Resetting session: ${sessionId}...`);

    const sessionDoc = db.collection('whatsapp_sessions').doc(sessionId);
    
    // Delete keys subcollection
    const keys = await sessionDoc.collection('keys').get();
    const batch = db.batch();
    keys.docs.forEach(doc => batch.delete(doc.ref));
    
    // Delete the main session doc
    batch.delete(sessionDoc);

    await batch.commit();
    console.log(`Session ${sessionId} cleared successfully.`);
}

async function run() {
    await reset('main-session');
    await reset('local-session');
    console.log('All sessions cleared. Run "npm start" now.');
    process.exit(0);
}

run().catch(err => {
    console.error('Failed to reset sessions:', err);
    process.exit(1);
});
