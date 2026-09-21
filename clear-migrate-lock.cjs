/**
 * Clears a stuck Prisma "migrate deploy" advisory lock (id 72707369) on the
 * database in this folder's .env DATABASE_URL.
 *
 * Why this is needed: through a connection pooler (e.g. pooled.db.prisma.io),
 * a `prisma migrate deploy` connection can grab the advisory lock, get killed
 * mid-deploy, and leave the connection (and the lock) alive. Every later
 * deploy then blocks on `pg_advisory_lock(72707369)` and fails with P1002.
 *
 * This script terminates the backend holding the lock and any blocked waiters,
 * which frees the lock so the next deploy can run.
 *
 *   Run from the Time-Flow-BE folder:  node clear-migrate-lock.cjs
 */
require('dotenv').config({ path: '.env', quiet: true });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const LOCK_ID = 72707369;

const j = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));

(async () => {
  try {
    const holders = await p.$queryRawUnsafe(
      "select pid from pg_locks where locktype = 'advisory' and (classid::bigint * 4294967296 + objid::bigint) = $1",
      LOCK_ID,
    );
    if (holders.length === 0) {
      console.log('No advisory lock', LOCK_ID, 'present — nothing to clear. A retry of the deploy should work.');
      return;
    }
    console.log('Backends on lock', LOCK_ID, ':', j(holders.map((h) => Number(h.pid))));
    for (const { pid } of holders) {
      const r = await p.$queryRawUnsafe('select pg_terminate_backend($1) as ok', Number(pid));
      console.log('  terminated pid', Number(pid), '->', j(r));
    }
    const left = await p.$queryRawUnsafe(
      "select pid from pg_locks where locktype = 'advisory' and (classid::bigint * 4294967296 + objid::bigint) = $1",
      LOCK_ID,
    );
    console.log(left.length === 0 ? '✅ Lock cleared. Re-run the deploy.' : `⚠️ Still held by: ${j(left)}`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exitCode = 1;
  } finally {
    await p.$disconnect();
  }
})();
