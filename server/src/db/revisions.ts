import { db } from './connection.js';

export const currentRevision = db.prepare(`SELECT value FROM sync_meta WHERE key = 'item_revision'`);

export const nextRevision = db.prepare(`UPDATE sync_meta SET value = value + 1 WHERE key = 'item_revision' RETURNING value`);
