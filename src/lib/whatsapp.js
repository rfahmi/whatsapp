const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { useFirestoreAuthState } = require('./auth');
const qrcode = require('qrcode-terminal');
const logger = require('./logger');

let sock = null;
let isConnected = false;

const connectToWhatsApp = async () => {
    // Use a different session ID for local development to avoid conflicts with production
    const sessionId = process.env.NODE_ENV === 'production' ? 'main-session' : 'local-test-session';
    const { state, saveCreds } = await useFirestoreAuthState(sessionId);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    // Dummy logger to completely silence the internal library logs
    const silentLogger = {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
        trace: () => {},
        child: () => silentLogger
    };
    
    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, silentLogger), 
        },
        logger: silentLogger,
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            logger.info('Scan the QR code below:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;
            
            if (statusCode === 440) {
                logger.error('CRITICAL CONFLICT: Another instance has logged in and kicked this bot. Please stop other processes or Cloud Run.');
            } else {
                logger.warn({ err: lastDisconnect.error?.message || lastDisconnect.error, reconnecting: shouldReconnect }, 'Connection closed');
            }

            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            logger.info('WhatsApp connection opened');
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
    if (!isConnected) {
        throw new Error('WhatsApp connection is not open. Message will be retried.');
    }
    const socket = await getSocket();
    logger.info({ to: jid }, 'Sending message');
    return await socket.sendMessage(jid, { text });
};

module.exports = { connectToWhatsApp, getSocket, sendMessage };
