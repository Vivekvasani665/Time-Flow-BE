import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// A Prisma config file turns OFF the CLI's automatic .env loading, so load it
// ourselves — migrate/seed read DATABASE_URL from here.
loadEnv({ path: path.join(__dirname, '.env') });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
