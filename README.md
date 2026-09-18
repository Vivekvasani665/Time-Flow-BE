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
npm run db:seed        # demo data
```

Configure `.env` — at minimum `DATABASE_URL`, `REDIS_URL` and `JWT_ACCESS_SECRET`
(32+ characters; generate with `openssl rand -base64 48`).

## Development

Run the API and the worker in two terminals:

```bash
npm run dev            # API on http://localhost:4000
npm run dev:worker     # emails, activity logs, inbox sync
```

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
