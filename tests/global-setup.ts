import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import Redis from 'ioredis';

/**
 * Brings the dedicated test database to a known state once per run:
 * apply migrations → truncate every table → seed → demo fixtures. Redis test DB is flushed.
 */
export default async function globalSetup() {
  const fileEnv = existsSync('.env.test') ? parse(readFileSync('.env.test')) : {};
  const env: NodeJS.ProcessEnv = { ...process.env, ...fileEnv, NODE_ENV: 'test' };
  const dbUrl = env.DATABASE_URL ?? '';
  if (!/test/.test(dbUrl)) throw new Error(`Refusing to run tests against a non-test database: ${dbUrl}`);

  execSync('npx prisma migrate deploy', { env, stdio: 'pipe' });
  const tables = [
    'role_permissions', 'project_members', 'notifications', 'activity_logs', 'refresh_tokens',
    'email_logs', 'tasks', 'projects', 'users', 'roles', 'permissions', 'two_factor_recovery_codes', 'login_otps', 'password_reset_requests', 'user_invitations',
  ].map((t) => `"${t}"`).join(', ');
  execSync(`npx prisma db execute --stdin --schema prisma/schema.prisma`, { env, input: `TRUNCATE ${tables} CASCADE;`, stdio: ['pipe', 'pipe', 'pipe'] });
  execSync('npx tsx prisma/seed.ts', { env, stdio: 'pipe' });
  execSync('npx tsx tests/demo-fixtures.ts', { env, stdio: 'pipe' });

  const redis = new Redis(env.REDIS_URL ?? 'redis://localhost:6379/1');
  await redis.flushdb();
  await redis.quit();
}
