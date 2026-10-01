# Time-Flow-BE

TimeFlow API server and background worker (Node.js, Express, Prisma, BullMQ).

## Requirements

- Node.js 20+
- PostgreSQL 16
- Redis

On macOS with Homebrew:

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

## Setup

```bash
npm install
createdb timeflow      # database named in DATABASE_URL
npx prisma generate
npm run db:deploy      # apply migrations
npm run db:seed        # permissions + roles (+ first admin from ADMIN_EMAIL)
```

Configure `.env` — at minimum `DATABASE_URL`, `REDIS_URL` and `JWT_ACCESS_SECRET`
(32+ characters; generate with `openssl rand -base64 48`).

## Development

Run the API and the worker in two terminals:

```bash
npm run dev            # API on http://localhost:4000
npm run dev:worker     # emails, activity logs, inbox sync
```

## Email

The Mailbox (`/api/emails`) sends through a background worker, so the worker must
be running for mail to leave. Messages support To / Cc / Bcc, drafts
(`draft: true`, `PATCH /api/emails/:id`, `POST /api/emails/:id/send`) and
attachments (`POST /api/emails/attachments`, then pass `attachmentIds`). Full
reference at `/api/docs`.

Pick the delivery provider with `EMAIL_PROVIDER` — switching is config only:

| `EMAIL_PROVIDER` | Needs | Notes |
| --- | --- | --- |
| `gmail` | `GMAIL_USER`, `GMAIL_APP_PASSWORD` (16-char App Password) | Replies are pulled back into the Inbox over IMAP |
| `resend` | `RESEND_API_KEY`, `EMAIL_FROM` | HTTPS — works where SMTP ports are blocked |
| `sendgrid` | `SENDGRID_API_KEY`, `EMAIL_FROM` | HTTPS |
| `brevo` | `BREVO_API_KEY`, `EMAIL_FROM` | HTTPS; same key as Brevo SMS |
| `smtp` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Any other SMTP relay |
| `mailpit` | — | Local catcher for development |
| `log` | — | Logs instead of sending |

`EMAIL_FROM` must be a sender or domain verified with the provider, e.g.
`EMAIL_FROM="TimeFlow <team@yourcompany.com>"`. A Gmail account can also be
set in the app under System → Email delivery, which takes precedence. Outside
production, real providers refuse to send unless `EMAIL_ALLOW_REAL_SEND=true`.

## Voice and video calls

1-to-1 calls in Chat. Audio and video go peer to peer (WebRTC); the API only
relays signaling over the chat socket (`/api/socket.io`) and keeps call history
(`GET /api/calls?userId=…`). Nothing is recorded.

Browsers find each other through ICE servers served by `GET /api/calls/ice-servers`:

| Variable | Default | Notes |
| --- | --- | --- |
| `CALL_STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated. Enough on most home and office networks |
| `CALL_TURN_URLS` | — | e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`. Needed behind strict NATs, mobile networks and corporate firewalls |
| `CALL_TURN_SECRET` | — | coturn `use-auth-secret` / `static-auth-secret`: each user gets expiring credentials (recommended) |
| `CALL_TURN_TTL_SECONDS` | `21600` | Lifetime of those credentials |
| `CALL_TURN_USERNAME`, `CALL_TURN_CREDENTIAL` | — | Static credentials, for a hosted TURN without a shared secret |
| `CALL_RING_TIMEOUT_SECONDS` | `45` | Unanswered calls become missed calls |
| `CALL_RECONNECT_GRACE_SECONDS` | `30` | How long a dropped connection may take to come back before the call ends |
| `RATE_LIMIT_CALL_MAX` | `10` | Calls a user may start per minute |

Browsers only allow the camera and microphone on `https://` (or `localhost`).
To try calls locally, sign in as two different users in two browsers (or a
normal and a private window); one account can't call itself.

## Recordings (screen & webcam)

Loom-style recordings live under `/recordings` in the app, in three modes:
**Full Screen**, **Full Screen + Webcam** and **Webcam Only**. Screen recordings
always capture an entire display the user picks in the browser's own sharing
dialog (a window or single tab is refused), so recording continues while they
switch tabs and apps, until they press Stop or end sharing. Recording happens
entirely in the browser (`getDisplayMedia`, `getUserMedia`, `MediaRecorder`);
nothing is uploaded until the user reviews the video and presses **Save
Recording**. Saving is three steps, and the video never passes through the API
or PostgreSQL:

1. `POST /api/recordings/upload-url` — reserves a recording, returns a signed PUT URL
2. the browser PUTs the file straight to object storage
3. `POST /api/recordings/complete` — the server reads the stored object back
   (size, file signature), checks project access, and stores the metadata

`GET /api/recordings`, `GET /api/recordings/:id` (signed playback and download
URLs) and `DELETE /api/recordings/:id` complete the API. A recording is visible to
its owner; attaching it to a project shares it with that project's members. The
owner, the project's manager, or anyone with `recordings.manage_all` (Super
Admin and Admin by default) can delete it.

| Variable | Default | Notes |
| --- | --- | --- |
| `STORAGE_DRIVER` | `local` | `r2` for Cloudflare R2 (or any S3-compatible bucket). `local` keeps files in `LOCAL_STORAGE_DIR` — fine for development, but wiped on hosts with ephemeral disks |
| `LOCAL_STORAGE_DIR` | `./storage` | Private: served only through expiring signed URLs at `/api/storage/…`, never under `/uploads` |
| `R2_ACCOUNT_ID` | — | Cloudflare account id; the endpoint becomes `https://<id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | — | An R2 API token with **Object Read & Write** on the bucket. Never sent to browsers |
| `R2_BUCKET` | — | Keep it private (no public access, no r2.dev URL) |
| `R2_ENDPOINT` | — | Overrides the endpoint (EU jurisdiction, MinIO, S3) |
| `R2_REGION` | `auto` | Leave `auto` for R2 |
| `RECORDING_MAX_BYTES` | `1073741824` (1 GiB) | Checked before issuing the URL and again against the stored object |
| `RECORDING_UPLOAD_URL_TTL_SECONDS` | `3600` | Lifetime of a signed upload URL |
| `RECORDING_PLAYBACK_URL_TTL_SECONDS` | `3600` | Lifetime of signed playback / download / thumbnail URLs |

**R2 setup.** Create a bucket (Cloudflare dashboard → R2), then an API token
scoped to it with Object Read & Write. The browser uploads and plays directly
against R2, so the bucket needs a CORS policy (R2 → bucket → Settings → CORS):

```json
[
  {
    "AllowedOrigins": ["https://your-timeflow-frontend.example"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range"],
    "MaxAgeSeconds": 3600
  }
]
```

Optionally add a lifecycle rule deleting objects under `recordings/` that are
never confirmed — the API also sweeps a user's abandoned uploads after 24 hours.

## Production

```bash
npm run build
npm run db:deploy
npm start              # API
npm run start:worker   # worker
```

## Tests

```bash
npm test
```
