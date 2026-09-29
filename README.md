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
