const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
}

// Specify the database ID 'whatsapp-bot'
const db = getFirestore('whatsapp-bot');

module.exports = { db };
