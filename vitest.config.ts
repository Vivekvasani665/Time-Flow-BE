import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Local runs read .env.test; CI provides the same variables through the job environment.
const testEnv = existsSync('.env.test') ? parse(readFileSync('.env.test')) : {};

export default defineConfig({
  test: {
    environment: 'node',
    env: { ...testEnv, NODE_ENV: 'test' },
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Suites share one Postgres database and Redis DB; run files serially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
