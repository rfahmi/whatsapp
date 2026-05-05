const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

if (!admin.apps.length) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    // On Cloud Run (Linux), if the path starts with /Users/ (macOS), it's definitely wrong.
    // We clear it so admin.credential.applicationDefault() can fallback to service account.
    if (credPath && credPath.startsWith('/Users/') && process.platform === 'linux') {
        console.warn(`Ignoring invalid local credential path: ${credPath}`);
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }

    try {
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
    } catch (err) {
        console.error('Failed to initialize Firebase Admin:', err.message);
    }
}

// Specify the database ID 'whatsapp-bot'
const db = getFirestore('whatsapp-bot');

module.exports = { db };
