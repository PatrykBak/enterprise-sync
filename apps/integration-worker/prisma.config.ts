import { defineConfig } from 'prisma/config';
import dotenv from 'dotenv';

dotenv.config();

const getDatabaseUrl = (): string => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return url;
};

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: getDatabaseUrl(),
  },
});
