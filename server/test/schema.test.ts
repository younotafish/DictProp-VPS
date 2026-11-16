import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applySchema } from '../src/db/schema.js';

const { db } = await import('../src/db.js');
const { stmts } = await import('../src/db/items.js');
const { imageStmts } = await import('../src/db/images.js');
const { orphanStmts, userStmts } = await import('../src/db/users.js');

// items and users as the server first created them in March 2026, with indexes the schema has since retired.
const MARCH_TABLES = `
  CREATE TABLE items (
    id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('vocab', 'phrase', 'sentence')), data TEXT NOT NULL,
    srs TEXT NOT NULL, saved_at INTEGER NOT NULL, updated_at INTEGER, is_deleted INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0
  );
  CREATE INDEX idx_items_type ON items(type);
  CREATE INDEX idx_items_updated ON items(updated_at);
  CREATE TABLE users (
    id TEXT PRIMARY KEY, google_id TEXT UNIQUE NOT NULL, email TEXT NOT NULL, display_name TEXT, photo_url TEXT,
    is_approved INTEGER DEFAULT 0, is_admin INTEGER DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_users_google_id ON users(google_id);
`;

// A file as the server left it once accounts arrived in March: items gained user_id by ALTER TABLE, with an index
// of its own, beside the new sessions table.
const MARCH_FILE = `${MARCH_TABLES}
  CREATE TABLE sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);
  ALTER TABLE items ADD COLUMN user_id TEXT;
  CREATE INDEX idx_items_user_id ON items(user_id);
  INSERT INTO items (id, type, data, srs, saved_at, user_id) VALUES ('march-item', 'vocab', '{}', '{}', 1, 'march-user');
`;

// Every table that later gained columns or lost indexes, each in the shape it was first created in (items and users
// in March, item_images in June, review_events, review_event_items and sentence_enrichments in July), with the
// retired indexes those shapes had. No real file held this mix: it runs every ALTER and DROP at once. The tables it
// leaves out were first created in their final shape, and a file that lacks a table gets it by CREATE.
const FIRST_SHAPES = `${MARCH_TABLES}
  CREATE TABLE review_events (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, item_id TEXT NOT NULL,
    item_type TEXT NOT NULL CHECK(item_type IN ('vocab', 'phrase', 'sentence')), reviewed_at INTEGER NOT NULL,
    previous_step INTEGER NOT NULL, next_step INTEGER NOT NULL
  );
  CREATE TABLE review_event_items (
    event_id TEXT NOT NULL, item_id TEXT NOT NULL, previous_srs TEXT NOT NULL, applied_srs TEXT NOT NULL,
    PRIMARY KEY (event_id, item_id)
  );
  CREATE INDEX idx_review_event_items_event ON review_event_items(event_id);
  CREATE TABLE item_images (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL, updated_at INTEGER);
  CREATE INDEX idx_item_images_user_id ON item_images(user_id);
  CREATE TABLE sentence_enrichments (
    lookup_hash TEXT PRIMARY KEY, source_id TEXT UNIQUE NOT NULL, text_hash TEXT NOT NULL, source_text TEXT NOT NULL,
    analysis TEXT NOT NULL, generated_at INTEGER NOT NULL, image_content_hash TEXT, image_mime_type TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sentence_enrichments_source_id ON sentence_enrichments(source_id);
  INSERT INTO items (id, type, data, srs, saved_at) VALUES ('first-shape-item', 'vocab', '{}', '{}', 1);
`;

/** Every table's columns and indexes, in a form two databases can be compared by. */
function shape(database: Database.Database) {
  const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, {
    columns: database.prepare(`PRAGMA table_info(${name})`).all(),
    indexes: (database.prepare(`PRAGMA index_list(${name})`).all() as Array<{ name: string; unique: number; partial: number }>)
      .map(index => ({
        name: index.name, unique: index.unique, partial: index.partial,
        columns: (database.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map(column => column.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }]));
}

const fresh = () => {
  const database = new Database(':memory:');
  applySchema(database);
  return database;
};

test('every table in its first shape upgrades to exactly the tables, columns and indexes of a fresh database', () => {
  const upgraded = new Database(':memory:');
  upgraded.exec(FIRST_SHAPES);
  applySchema(upgraded);
  assert.deepEqual(shape(upgraded), shape(fresh()));
  const row = upgraded.prepare(`SELECT user_id, project, revision FROM items WHERE id = 'first-shape-item'`).get();
  assert.deepEqual(row, { user_id: null, project: null, revision: 0 });
});

test('a file from March, once accounts arrived, upgrades to exactly a fresh database and keeps its rows', () => {
  const march = new Database(':memory:');
  march.exec(MARCH_FILE);
  applySchema(march);
  assert.deepEqual(shape(march), shape(fresh()));
  const row = march.prepare(`SELECT user_id, project, revision FROM items WHERE id = 'march-item'`).get();
  assert.deepEqual(row, { user_id: 'march-user', project: null, revision: 0 });
});

test('applying the schema again changes nothing', () => {
  const database = fresh();
  const before = shape(database);
  applySchema(database);
  assert.deepEqual(shape(database), before);
});

test('the retired indexes and the projects table are gone', () => {
  const database = fresh();
  const names = new Set((database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>)
    .map(index => index.name));
  for (const retired of [
    'idx_items_type', 'idx_items_updated', 'idx_items_user_id', 'idx_users_google_id',
    'idx_sentence_enrichments_source_id', 'idx_item_images_user_id', 'idx_review_event_items_event',
    'idx_items_project', 'idx_projects_user_id',
  ]) {
    assert.equal(names.has(retired), false, retired);
  }
  assert.equal(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'`).get(), undefined);
});

test('a file that still has the projects table, a row in it and its two indexes upgrades to exactly a fresh database, twice', () => {
  // As the image before the drop left a file: the retired table and the indexes it kept for the audit's project counts.
  const database = fresh();
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL);
    INSERT INTO projects (id, name, user_id, created_at) VALUES ('legacy', 'Legacy', 'user', 1);
    CREATE INDEX idx_projects_user_id ON projects(user_id);
    CREATE INDEX idx_items_project ON items(project);
  `);
  applySchema(database);
  assert.deepEqual(shape(database), shape(fresh()));
  applySchema(database);
  assert.deepEqual(shape(database), shape(fresh()));
});

test('statements search the indexes that remain instead of scanning tables', () => {
  const plan = (sql: string, ...params: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(row => row.detail).join('\n');
  assert.match(plan(stmts.getById.source, 'id'), /SEARCH items USING INDEX sqlite_autoindex_items_1 \(id=\?\)/);
  assert.match(plan(stmts.getAfterRevision.source, 'user', 0, 0, '', 10), /SEARCH items USING INDEX idx_items_user_revision/);
  assert.doesNotMatch(plan(stmts.getAfterRevision.source, 'user', 0, 0, '', 10), /TEMP B-TREE/);
  assert.match(plan(stmts.undoneReviewAt.source, 'user', 1, 'id'), /SEARCH review_events USING INDEX idx_review_events_user_time/);
  // The phrase scan that finds the owners of an image.
  assert.match(plan(stmts.phrasesMentioning.source, 'user', '%x%'), /SEARCH items USING INDEX idx_items_user_type/);
  assert.match(plan(imageStmts.manifest.source, 'user'), /SEARCH i USING COVERING INDEX idx_item_images_user_versions/);
  // Blob cleanup's checks for anything that still references a blob.
  for (const cleanup of [plan(imageStmts.deleteUnreferencedBlob.source, 'hash'), plan(imageStmts.deleteAllUnreferencedBlobs.source)]) {
    assert.match(cleanup, /SEARCH item_images USING COVERING INDEX idx_item_images_content_hash/);
    assert.match(cleanup, /SEARCH sentence_enrichments USING COVERING INDEX idx_sentence_enrichments_image/);
  }
  // Sign-in, and the sign-up claim of rows from before accounts.
  assert.match(plan(userStmts.findByGoogleId.source, 'g'), /SEARCH users USING INDEX sqlite_autoindex_users_2/);
  assert.match(plan(orphanStmts.items.source, 'user'), /SEARCH items USING (COVERING )?INDEX idx_items_user_/);
  assert.match(plan(orphanStmts.images.source, 'user'), /SEARCH item_images USING (COVERING )?INDEX idx_item_images_user_versions/);
});
