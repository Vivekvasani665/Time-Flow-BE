# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────
# TimeFlow backend — one image, two processes:
#   API:    node dist/src/server.js
#   Worker: node dist/src/worker.js
#   Migrate/seed (one-shot): npx prisma migrate deploy && node dist/prisma/seed.js
# ─────────────────────────────────────────────────────────────

ARG NODE_VERSION=22-alpine

# ── deps: full dependency tree for building ─────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ── build: compile TypeScript + generate Prisma client ──────
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.build.json

# ── prod-deps: runtime dependencies only ─────────────────────
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY package.json package-lock.json ./
COPY prisma ./prisma
# `prisma` CLI is a runtime dependency (migrate deploy in the migrate service).
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund \
  && npx prisma generate

# ── runner ───────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    UPLOAD_DIR=/app/uploads
# openssl for Prisma engines, wget for the compose healthcheck, tini as PID 1 so
# SIGTERM reaches node and graceful shutdown runs.
RUN apk add --no-cache openssl libc6-compat wget tini \
  && addgroup -S app && adduser -S app -G app \
  && mkdir -p /app/uploads/avatars && chown -R app:app /app/uploads

COPY --chown=app:app package.json ./
COPY --chown=app:app --from=prod-deps /app/node_modules ./node_modules
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app --from=build /app/dist ./dist

USER app
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/server.js"]
