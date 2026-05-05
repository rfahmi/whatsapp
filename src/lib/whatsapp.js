const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { useFirestoreAuthState } = require('./auth');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const logger = pino({ level: 'info' });

let sock = null;

const connectToWhatsApp = async () => {
    const { state, saveCreds } = await useFirestoreAuthState('main-session');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: true,
        logger,
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('Scan the QR code below:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('opened connection');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
};

const getSocket = async () => {
    if (!sock) {
        await connectToWhatsApp();
    }
    return sock;
};

const sendMessage = async (jid, text) => {
    const socket = await getSocket();
    return await socket.sendMessage(jid, { text });
};

module.exports = { connectToWhatsApp, getSocket, sendMessage };
