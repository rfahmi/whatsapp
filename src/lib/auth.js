const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const { db } = require('./firestore');

const useFirestoreAuthState = async (sessionId) => {
    const sessionDoc = db.collection('whatsapp_sessions').doc(sessionId);
    const keysCollection = sessionDoc.collection('keys');

    const readData = async (type, id) => {
        try {
            const doc = await keysCollection.doc(`${type}-${id}`).get();
            if (doc.exists) {
                const data = JSON.stringify(doc.data());
                return JSON.parse(data, BufferJSON.reviver);
            }
        } catch (error) {
            console.error('Error reading data from Firestore:', error);
        }
        return null;
    };

    const writeData = async (data, type, id) => {
        try {
            const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
            await keysCollection.doc(`${type}-${id}`).set(value);
        } catch (error) {
            console.error('Error writing data to Firestore:', error);
        }
    };

    const removeData = async (type, id) => {
        try {
            await keysCollection.doc(`${type}-${id}`).delete();
        } catch (error) {
            console.error('Error removing data from Firestore:', error);
        }
    };

    const credsDoc = await sessionDoc.get();
    let creds = credsDoc.exists ? JSON.parse(JSON.stringify(credsDoc.data().creds), BufferJSON.reviver) : initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(type, id);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (value) {
                                tasks.push(writeData(value, category, id));
                            } else {
                                tasks.push(removeData(category, id));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            const value = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
            await sessionDoc.set({ creds: value }, { merge: true });
        }
    };
};

module.exports = { useFirestoreAuthState };
