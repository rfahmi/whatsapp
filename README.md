# WhatsApp Bot

A WhatsApp messaging service built on [Baileys](https://github.com/WhiskeySockets/Baileys) with anti-ban protection, a Firestore-backed message queue, and Cloud Run deployment support.

---

## Anti-Ban Rules

All configurable values are defined in the `ANTIBAN` object at the top of their respective files.

---

### `src/lib/whatsapp.js` — Connection & Sending

| Rule | Variable | Default | Description |
|---|---|---|---|
| **Browser fingerprint** | `ANTIBAN.BROWSER` | `Browsers.macOS('Chrome')` | Presents the connection as Chrome on macOS to WhatsApp servers instead of an unknown client |
| **No auto-online** | `ANTIBAN.MARK_ONLINE_ON_CONNECT` | `false` | Prevents broadcasting "online" status immediately on connect, which is a bot-like pattern |
| **No history sync** | `ANTIBAN.SYNC_FULL_HISTORY` | `false` | Suppresses full chat history sync on connect, which generates unusual server traffic |
| **Presence delay** | `ANTIBAN.PRESENCE_ONLINE_DELAY_MIN_MS` / `MAX_MS` | `1000–3000ms` | Random delay before announcing "available" after connecting, mimicking a human opening the app |
| **Typing simulation** | `ANTIBAN.TYPING_MS_PER_CHAR` | `30ms/char` | Duration of the "composing…" indicator before each send, scaled to message length |
| **Typing bounds** | `ANTIBAN.TYPING_MIN_MS` / `MAX_MS` | `1500–5000ms` | Minimum and maximum typing duration regardless of message length |
| **Typing jitter** | `ANTIBAN.TYPING_JITTER_MS` | `1000ms` | Random additional time added on top of the computed typing delay |
| **Reconnect backoff** | `ANTIBAN.RECONNECT_BACKOFF_BASE_MS` / `MAX_MS` | `1000ms base, 60000ms cap` | Exponential backoff on disconnect (1s → 2s → 4s … → 60s) to avoid hammering reconnects |
| **Reconnect jitter** | `ANTIBAN.RECONNECT_JITTER_MS` | `3000ms` | Random jitter added to each reconnect delay |
| **Version cache TTL** | `ANTIBAN.VERSION_CACHE_TTL_MS` | `86400000ms (24h)` | How long to reuse the cached Baileys WA version before re-fetching from GitHub CDN |

---

### `src/lib/queue.js` — Queue & Rate Limiting

| Rule | Variable | Default | Description |
|---|---|---|---|
| **Poll interval** | `ANTIBAN.QUEUE_POLL_INTERVAL_MS` | `15000ms (15s)` | How often the queue worker checks for new messages. Slower = less burst activity |
| **Batch size** | `ANTIBAN.QUEUE_BATCH_SIZE` | `3` | Max messages processed per poll cycle. Prevents processing many messages simultaneously |
| **Inter-message delay** | `ANTIBAN.INTER_MESSAGE_DELAY_MIN_MS` / `MAX_MS` | `5000–15000ms` | Random delay between each message sent within a batch |
| **Max retries** | `ANTIBAN.MAX_RETRIES` | `3` | A message that fails this many times is permanently marked `failed` |
| **Retry backoff** | `ANTIBAN.RETRY_BACKOFF_BASE_MS` / `MULTIPLIER` / `MAX_MS` | `60s base, ×5, 15m cap` | Failed messages are retried after 1 min → 5 min → 15 min, not immediately |
| **Stuck message timeout** | `ANTIBAN.STUCK_MESSAGE_TIMEOUT_MS` | `120000ms (2m)` | Messages stuck in `processing` longer than this are reset to `failed` for recovery |
| **Global hourly cap** | `ANTIBAN.HOURLY_SEND_CAP` | `60` | Max total messages sent across all recipients per hour. Queue pauses when reached |
| **Per-contact hourly cap** | `ANTIBAN.PER_CONTACT_HOURLY_CAP` | `5` | Max messages to the same number per hour. Prevents targeting a single recipient repeatedly |
| **Per-contact reschedule** | `ANTIBAN.PER_CONTACT_RESCHEDULE_MS` | `3600000ms (1h)` | How long to defer a message when its recipient's hourly cap is hit |
| **Contact suspension threshold** | `ANTIBAN.CONTACT_SUSPENSION_THRESHOLD` | `3` | Number of consecutive delivery failures before a contact is suspended |
| **Contact suspension duration** | `ANTIBAN.CONTACT_SUSPENSION_DURATION_MS` | `86400000ms (24h)` | How long a suspended contact is skipped before retrying |

---

## Architecture

```
POST /send-message
       │
       ▼
  Firestore (messages collection)
  status: pending
       │
       ▼
  Queue Worker (every 15s)
  ├── Global hourly cap check
  ├── Per-contact rate limit check
  ├── Contact suspension check
  ├── Retry backoff check (nextRetryAt)
  └── sendMessage()
            ├── onWhatsApp() — verify number exists
            ├── sendPresenceUpdate('composing')
            ├── typing delay (scaled to message length)
            ├── sendPresenceUpdate('paused')
            └── socket.sendMessage()
```

---

## API

All endpoints require the `x-api-key` header (or `Authorization: Bearer <key>`).

| Method | Path | Description |
|---|---|---|
| `POST` | `/send-message` | Queue a message. Body: `{ to, message }` |
| `GET` | `/qr` | View QR code to scan (HTML or `?format=json`) |
| `GET` | `/health` | Health check |
| `POST` | `/reset-session` | Clear session and restart |

---

## Environment Variables

| Variable | Where | Required | Description |
|---|---|---|---|
| `API_KEY` | App + GitHub Secret | Yes | Secret key for API authentication |
| `NODE_ENV` | App | No | Set to `production` for Cloud Run; uses a different session ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | App | No | Path to Firebase service account JSON (local dev only) |
| `PORT` | App | No | HTTP port (default: `8080`) |
| `LOG_LEVEL` | App | No | Pino log level (default: `info`) |
| `GCP_PROJECT_ID` | GitHub Secret | Yes | Google Cloud project ID used during Cloud Run deployment |
| `GCP_SA_KEY` | GitHub Secret | Yes | GCP service account key JSON for authenticating GitHub Actions to Google Cloud |
| `DOCKERHUB_USERNAME` | GitHub Secret | Yes | Docker Hub username for pushing the container image |
| `DOCKERHUB_TOKEN` | GitHub Secret | Yes | Docker Hub access token for authentication |

---

## Firestore Index (Required)

The queue query uses three filters and requires a **composite index**:

- **Collection**: `messages`
- **Fields**: `status ASC`, `retries ASC`, `nextRetryAt ASC`

When first deployed, Firestore will throw an error with a direct link to auto-create the index. Click the link, or create it manually in the Firebase console.
