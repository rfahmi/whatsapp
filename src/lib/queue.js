const { db } = require('./firestore');
const { sendMessage, isReady } = require('./whatsapp');
const logger = require('./logger');

// ─── Anti-Ban Configuration ───────────────────────────────────────────────────
const ANTIBAN = {
    // Queue worker: how often to check for new messages
    QUEUE_POLL_INTERVAL_MS: 15_000,          // 15 seconds

    // Queue worker: max messages picked up per poll cycle
    QUEUE_BATCH_SIZE: 3,

    // Delay between each message sent within a batch (random range)
    INTER_MESSAGE_DELAY_MIN_MS: 5_000,       // 5 seconds
    INTER_MESSAGE_DELAY_MAX_MS: 15_000,      // 15 seconds

    // Max total send attempts per message before permanent failure
    MAX_RETRIES: 3,

    // Stuck message recovery: reclaim 'processing' messages older than this
    STUCK_MESSAGE_TIMEOUT_MS: 2 * 60_000,   // 2 minutes

    // Retry backoff: delay = min(BASE * MULTIPLIER^(attempt-1), MAX)
    RETRY_BACKOFF_BASE_MS: 60_000,           // 1 minute (attempt 1)
    RETRY_BACKOFF_MULTIPLIER: 5,             // → 5 min (attempt 2), 15 min (attempt 3)
    RETRY_BACKOFF_MAX_MS: 15 * 60_000,      // 15 minutes hard cap

    // Global hourly send cap across all recipients
    HOURLY_SEND_CAP: 60,                     // max 60 messages per hour

    // Per-contact hourly send cap
    PER_CONTACT_HOURLY_CAP: 5,              // max 5 messages per contact per hour
    // Reschedule delay applied when per-contact cap is hit
    PER_CONTACT_RESCHEDULE_MS: 60 * 60_000, // 1 hour

    // Contact suspension: suspend after this many consecutive delivery failures
    CONTACT_SUSPENSION_THRESHOLD: 3,
    CONTACT_SUSPENSION_DURATION_MS: 24 * 60 * 60_000, // 24 hours
};
// ─────────────────────────────────────────────────────────────────────────────

const randomDelay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

let isProcessing = false;

// Per-contact rate limit: max 5 messages per contact per hour (in-memory)
const contactSendLog = new Map();

const isContactRateLimited = (jid) => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const sends = (contactSendLog.get(jid) || []).filter(t => t > oneHourAgo);
    contactSendLog.set(jid, sends);
    return sends.length >= ANTIBAN.PER_CONTACT_HOURLY_CAP;
};

const recordContactSend = (jid) => {
    const sends = contactSendLog.get(jid) || [];
    sends.push(Date.now());
    contactSendLog.set(jid, sends);
};

// Contact suspension: skip contact for 24h after 3 consecutive send failures
const contactFailures = new Map();

const isContactSuspended = (jid) => {
    const entry = contactFailures.get(jid);
    if (!entry?.suspendedUntil) return false;
    return Date.now() < entry.suspendedUntil;
};

const recordContactFailure = (jid) => {
    const entry = contactFailures.get(jid) || { count: 0, suspendedUntil: null };
    entry.count++;
    if (entry.count >= ANTIBAN.CONTACT_SUSPENSION_THRESHOLD) {
        entry.suspendedUntil = Date.now() + ANTIBAN.CONTACT_SUSPENSION_DURATION_MS;
        entry.count = 0;
        logger.warn({ to: jid }, 'Contact suspended after consecutive failures');
    }
    contactFailures.set(jid, entry);
};

const clearContactFailures = (jid) => contactFailures.delete(jid);

const addMessageToQueue = async (to, message) => {
    const docRef = db.collection('messages').doc();
    await docRef.set({
        to,
        message,
        status: 'pending',
        createdAt: new Date(),
        retries: 0,
        nextRetryAt: new Date()
    });
    return docRef.id;
};

const processQueue = async () => {
    if (isProcessing) return;
    
    // Skip if WhatsApp is not connected yet
    if (!isReady()) {
        return;
    }

    isProcessing = true;
    try {
        const messagesRef = db.collection('messages');
        
        // 1. Recover stuck messages (status='processing' and processingAt < 2 mins ago)
        // We filter in memory to avoid needing another composite index
        const stuckSnapshot = await messagesRef.where('status', '==', 'processing').get();
        const stuckTimeout = Date.now() - ANTIBAN.STUCK_MESSAGE_TIMEOUT_MS;
        
        for (const doc of stuckSnapshot.docs) {
            const data = doc.data();
            const processingAt = data.processingAt?.toDate?.()?.getTime() || 0;
            if (processingAt < stuckTimeout) {
                logger.warn({ messageId: doc.id }, 'Recovering stuck message');
                await doc.ref.update({ status: 'failed', lastError: 'Timeout/Stuck' });
            }
        }

        // 2. Fetch new messages to process (only those ready to retry)
        const now = new Date();
        const query = messagesRef.where('status', 'in', ['pending', 'failed'])
            .where('retries', '<', ANTIBAN.MAX_RETRIES)
            .where('nextRetryAt', '<=', now)
            .limit(ANTIBAN.QUEUE_BATCH_SIZE);

        const snapshot = await query.get();

        if (snapshot.empty) return;

        for (const doc of snapshot.docs) {
            const data = doc.data();

            // Pre-flight: per-contact rate limit (5 msgs/hr per recipient)
            if (isContactRateLimited(data.to)) {
                logger.warn({ to: data.to, messageId: doc.id }, 'Per-contact rate limit reached. Rescheduling.');
                await doc.ref.update({ nextRetryAt: new Date(Date.now() + ANTIBAN.PER_CONTACT_RESCHEDULE_MS) });
                continue;
            }

            // Pre-flight: skip suspended contacts
            if (isContactSuspended(data.to)) {
                logger.warn({ to: data.to, messageId: doc.id }, 'Contact suspended. Marking as failed.');
                await doc.ref.update({ status: 'failed', lastError: 'Contact suspended due to repeated delivery failures' });
                continue;
            }

            const success = await db.runTransaction(async (transaction) => {
                const messageDoc = await transaction.get(doc.ref);
                const txData = messageDoc.data();

                if (txData.status === 'pending' || txData.status === 'failed') {
                    transaction.update(doc.ref, { 
                        status: 'processing', 
                        processingAt: new Date(),
                        retries: txData.retries + 1
                    });
                    return true;
                }
                return false;
            });

            if (!success) continue;

            logger.info({ messageId: doc.id, to: data.to }, 'Processing message');

            // Hourly send cap
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            const recentSentSnap = await db.collection('messages')
                .where('status', '==', 'sent')
                .where('sentAt', '>', oneHourAgo)
                .count()
                .get();
            if (recentSentSnap.data().count >= ANTIBAN.HOURLY_SEND_CAP) {
                logger.warn({ cap: ANTIBAN.HOURLY_SEND_CAP }, 'Hourly send cap reached. Pausing queue.');
                break;
            }

            try {
                await sendMessage(data.to, data.message);
                await doc.ref.update({ status: 'sent', sentAt: new Date() });
                recordContactSend(data.to);
                clearContactFailures(data.to);
                logger.info({ messageId: doc.id }, 'Message sent successfully');
            } catch (error) {
                logger.error({ messageId: doc.id, err: error.message }, 'Failed to send message');
                recordContactFailure(data.to);
                const retries = (data.retries || 0) + 1;
                const backoffMs = Math.min(ANTIBAN.RETRY_BACKOFF_BASE_MS * Math.pow(ANTIBAN.RETRY_BACKOFF_MULTIPLIER, retries - 1), ANTIBAN.RETRY_BACKOFF_MAX_MS);
                await doc.ref.update({
                    status: 'failed',
                    lastError: error.message,
                    nextRetryAt: new Date(Date.now() + backoffMs)
                });
            }

            // Anti-ban: random inter-message delay to avoid burst sending
            await randomDelay(ANTIBAN.INTER_MESSAGE_DELAY_MIN_MS, ANTIBAN.INTER_MESSAGE_DELAY_MAX_MS);
        }
    } catch (error) {
        logger.error({ err: error.message }, 'Error in processQueue');
    } finally {
        isProcessing = false;
    }
};

const startQueueWorker = () => {
    logger.info('Queue worker started');
    setInterval(processQueue, ANTIBAN.QUEUE_POLL_INTERVAL_MS);
};

module.exports = { addMessageToQueue, startQueueWorker };
