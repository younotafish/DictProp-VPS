import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (one level above server/)
config({ path: resolve(__dirname, '../../.env') });

export const env = {
  PORT: parseInt(process.env.PORT || '3001', 10),
  DEEPINFRA_API_KEY: process.env.DEEPINFRA_API_KEY || '',
  REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN || '',
  DATA_DIR: process.env.DATA_DIR || resolve(__dirname, '../../data'),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
};
