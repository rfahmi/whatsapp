const { default: makeWASocket, Browsers, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { useFirestoreAuthState } = require('./auth');
const qrcode = require('qrcode-terminal');
const logger = require('./logger');

const { db } = require('./firestore');

// ─── Anti-Ban Configuration ───────────────────────────────────────────────────
const ANTIBAN = {
    // Browser fingerprint presented to WhatsApp servers
    BROWSER: Browsers.macOS('Chrome'),

    // Do not broadcast 'online' immediately on connect
    MARK_ONLINE_ON_CONNECT: false,

    // Suppress full chat history sync on connect
    SYNC_FULL_HISTORY: false,

    // Delay before announcing 'available' after connection opens (random range)
    PRESENCE_ONLINE_DELAY_MIN_MS: 1_000,    // 1 second
    PRESENCE_ONLINE_DELAY_MAX_MS: 3_000,    // 3 seconds

    // Typing simulation: ms per character (clamped to MIN–MAX)
    TYPING_MS_PER_CHAR: 30,
    TYPING_MIN_MS: 1_500,                   // 1.5 seconds
    TYPING_MAX_MS: 5_000,                   // 5 seconds
    TYPING_JITTER_MS: 1_000,               // up to +1 second jitter

    // Reconnect backoff: delay = min(BASE * 2^(attempt-1), MAX) + jitter
    RECONNECT_BACKOFF_BASE_MS: 1_000,       // 1 second
    RECONNECT_BACKOFF_MAX_MS: 60_000,       // 60 seconds hard cap
    RECONNECT_JITTER_MS: 3_000,            // up to +3 seconds jitter

    // Cache the Baileys WA version for this long before re-fetching from CDN
    VERSION_CACHE_TTL_MS: 24 * 60 * 60_000, // 24 hours
};
// ─────────────────────────────────────────────────────────────────────────────

const randomDelay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

let sock = null;
let isConnected = false;
let lastQr = null;
let reconnectAttempts = 0;
let cachedVersion = null;
let versionCachedAt = 0;
const instanceId = Math.random().toString(36).substring(7);

const connectToWhatsApp = async () => {
    // Use a different session ID for local development to avoid conflicts with production
    const sessionId = process.env.NODE_ENV === 'production' ? 'main-session' : 'local-test-session';
    const { state, saveCreds } = await useFirestoreAuthState(sessionId);
    let version;
    if (cachedVersion && (Date.now() - versionCachedAt < ANTIBAN.VERSION_CACHE_TTL_MS)) {
        version = cachedVersion;
    } else {
        ({ version } = await fetchLatestBaileysVersion());
        cachedVersion = version;
        versionCachedAt = Date.now();
    }

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
        browser: ANTIBAN.BROWSER,
        markOnlineOnConnect: ANTIBAN.MARK_ONLINE_ON_CONNECT,
        syncFullHistory: ANTIBAN.SYNC_FULL_HISTORY,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            lastQr = qr;
            logger.info({ instanceId }, '>> New QR Code received. Please scan:');
            
            // Store QR in Firestore for remote retrieval
            try {
                await db.collection('whatsapp_sessions').doc(sessionId).set({ 
                    lastQr: qr,
                    qrUpdatedAt: new Date(),
                    instanceId: instanceId
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
                reconnectAttempts++;
                const backoff = Math.min(ANTIBAN.RECONNECT_BACKOFF_BASE_MS * Math.pow(2, reconnectAttempts - 1), ANTIBAN.RECONNECT_BACKOFF_MAX_MS);
                const jitter = Math.floor(Math.random() * ANTIBAN.RECONNECT_JITTER_MS);
                logger.info({ attempt: reconnectAttempts, delayMs: backoff + jitter }, 'Scheduling reconnect');
                setTimeout(connectToWhatsApp, backoff + jitter);
            }
        } else if (connection === 'open') {
            isConnected = true;
            reconnectAttempts = 0;
            lastQr = null;
            // Clear QR from Firestore when connected
            await db.collection('whatsapp_sessions').doc(sessionId).set({ 
                lastQr: null 
            }, { merge: true });
            logger.info('WhatsApp connection opened');
            // Announce presence naturally after a short delay
            try {
                await randomDelay(ANTIBAN.PRESENCE_ONLINE_DELAY_MIN_MS, ANTIBAN.PRESENCE_ONLINE_DELAY_MAX_MS);
                await sock.sendPresenceUpdate('available');
            } catch (_) {}
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

const isReady = () => isConnected;

const getQr = () => lastQr;

const sendMessage = async (jid, content) => {
    if (!isConnected) {
        throw new Error('WhatsApp connection is not open. Message will be retried.');
    }
    const socket = await getSocket();
    
    // If it's a simple string or an object with text, send it
    const text = typeof content === 'string' ? content : (content.text || content.message || '');
    const snippet = text.replace(/\n/g, ' ').substring(0, 50) + (text.length > 50 ? '...' : '');
    
    logger.info({ to: jid, snippet }, 'Sending message');

    // Simulate human typing: composing presence → delay scaled to message length → send
    try {
        await socket.sendPresenceUpdate('composing', jid);
        const typingDelay = Math.min(Math.max(text.length * ANTIBAN.TYPING_MS_PER_CHAR, ANTIBAN.TYPING_MIN_MS), ANTIBAN.TYPING_MAX_MS);
        await randomDelay(typingDelay, typingDelay + ANTIBAN.TYPING_JITTER_MS);
        await socket.sendPresenceUpdate('paused', jid);
    } catch (_) {
        // Presence update failure should not block message delivery
    }

    // Verify recipient is on WhatsApp before sending
    try {
        const [result] = await socket.onWhatsApp(jid);
        if (!result?.exists) {
            throw new Error(`Number ${jid} is not registered on WhatsApp`);
        }
    } catch (err) {
        if (err.message.includes('not registered')) throw err;
        // onWhatsApp check itself failed (network/timeout) — proceed anyway
        logger.warn({ to: jid, err: err.message }, 'onWhatsApp check failed, proceeding');
    }

    return await socket.sendMessage(jid, { text });
};

module.exports = { connectToWhatsApp, getSocket, sendMessage, getQr, isReady, instanceId };
