const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { useFirestoreAuthState } = require('./auth');
const qrcode = require('qrcode-terminal');
const logger = require('./logger');

const { db } = require('./firestore');
let sock = null;
let isConnected = false;
let lastQr = null;

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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            lastQr = qr;
            logger.info('>> New QR Code received. Please scan:');
            
            // Store QR in Firestore for remote retrieval
            try {
                await db.collection('whatsapp_sessions').doc(sessionId).set({ 
                    lastQr: qr,
                    qrUpdatedAt: new Date()
                }, { merge: true });
            } catch (err) {
                logger.error({ err: err.message }, 'Failed to store QR in Firestore');
            }

            qrcode.generate(qr, { small: true }, (code) => {
                // Log directly to console to avoid JSON escaping in Cloud Run logs
                console.log('\n' + code + '\n');
            });
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
            lastQr = null;
            // Clear QR from Firestore when connected
            await db.collection('whatsapp_sessions').doc(sessionId).set({ 
                lastQr: null 
            }, { merge: true });
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

const getQr = () => lastQr;

const sendMessage = async (jid, content) => {
    if (!isConnected) {
        throw new Error('WhatsApp connection is not open. Message will be retried.');
    }
    const socket = await getSocket();
    logger.info({ to: jid }, 'Sending message');

    // If it's a simple string, send it as text
    if (typeof content === 'string') {
        return await socket.sendMessage(jid, { text: content });
    }

    // If it contains buttons, format as interactive message (Native Flow)
    if (content.buttons && Array.isArray(content.buttons)) {
        return await socket.sendMessage(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: {
                        body: { text: content.text || content.message },
                        footer: { text: content.footer || '' },
                        header: { title: '', hasMediaAttachment: false },
                        nativeFlowMessage: {
                            buttons: content.buttons.map(btn => ({
                                name: 'quick_reply',
                                buttonParamsJson: JSON.stringify({
                                    display_text: btn.text,
                                    id: btn.id
                                })
                            }))
                        }
                    }
                }
            }
        });
    }

    // Otherwise send as is (allows for other Baileys message types)
    return await socket.sendMessage(jid, content);
};

module.exports = { connectToWhatsApp, getSocket, sendMessage, getQr };
