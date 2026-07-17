import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (one level above server/)
config({ path: resolve(__dirname, '../../.env') });

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

export const env = {
  PORT: parsePort(process.env.PORT),
  DEEPINFRA_API_KEY: process.env.DEEPINFRA_API_KEY || '',
  REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN || '',
  DATA_DIR: process.env.DATA_DIR || resolve(__dirname, '../../data'),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  PUBLIC_ORIGIN: (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, ''),
  // Local dev only: when '1', skip Google auth and use a synthetic admin user. Never set in prod.
  DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS === '1',
};
