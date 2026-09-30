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

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_AUTH_BYPASS = process.env.DEV_AUTH_BYPASS === '1';
if (DEV_AUTH_BYPASS && IS_PRODUCTION) {
  throw new Error('DEV_AUTH_BYPASS=1 would make every visitor an admin; it is refused when NODE_ENV=production');
}

export const env = {
  IS_PRODUCTION,
  PORT: parsePort(process.env.PORT),
  DEEPINFRA_API_KEY: process.env.DEEPINFRA_API_KEY || '',
  DATA_DIR: process.env.DATA_DIR || resolve(__dirname, '../../data'),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  OWNER_GOOGLE_EMAIL: process.env.OWNER_GOOGLE_EMAIL || '',
  PUBLIC_ORIGIN: (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, ''),
  // Local dev only: when '1', skip Google auth and use a synthetic admin user. Refused in production, and the
  // server then listens on loopback only, so the no-auth API isn't reachable from the local network.
  DEV_AUTH_BYPASS,
};
