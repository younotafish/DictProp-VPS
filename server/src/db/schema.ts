import type Database from 'better-sqlite3';

/** Create every table and index, and bring an older database file up to date. Runs before any statement is prepared. */
export function applySchema(db: Database.Database): void {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('vocab', 'phrase', 'sentence')),
      data TEXT NOT NULL,
      srs TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      updated_at INTEGER,
      is_deleted INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_id TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      photo_url TEXT,
      is_approved INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('item_revision', 0);

    CREATE TABLE IF NOT EXISTS review_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK(item_type IN ('vocab', 'phrase', 'sentence')),
      reviewed_at INTEGER NOT NULL,
      previous_step INTEGER NOT NULL,
      next_step INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_events_user_time ON review_events(user_id, reviewed_at);
  `);

  // Migration: add user_id column to items if missing
  const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[];
  if (!columns.some(c => c.name === 'user_id')) {
    db.exec(`ALTER TABLE items ADD COLUMN user_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_user_id ON items(user_id)`);
  }
  if (!columns.some(c => c.name === 'revision')) {
    db.exec(`ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_user_revision ON items(user_id, revision, id)`);
  // Phrase scans (image owners, the inline-image fallback) read the user's phrase rows, not the library.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_user_type ON items(user_id, type)`);

  const reviewColumns = db.prepare(`PRAGMA table_info(review_events)`).all() as { name: string }[];
  if (!reviewColumns.some(column => column.name === 'rating')) {
    db.exec(`ALTER TABLE review_events ADD COLUMN rating TEXT NOT NULL DEFAULT 'good'`);
  }
  if (!reviewColumns.some(column => column.name === 'task_type')) {
    db.exec(`ALTER TABLE review_events ADD COLUMN task_type TEXT`);
  }
  if (!reviewColumns.some(column => column.name === 'duration_ms')) {
    db.exec(`ALTER TABLE review_events ADD COLUMN duration_ms INTEGER`);
  }
  if (!reviewColumns.some(column => column.name === 'session_id')) {
    db.exec(`ALTER TABLE review_events ADD COLUMN session_id TEXT`);
  }
  if (!reviewColumns.some(column => column.name === 'undone_at')) {
    db.exec(`ALTER TABLE review_events ADD COLUMN undone_at INTEGER`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_event_items (
      event_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      previous_srs TEXT NOT NULL,
      applied_srs TEXT NOT NULL,
      PRIMARY KEY (event_id, item_id)
    );
    DROP INDEX IF EXISTS idx_review_event_items_event;
  `);
  // The item's revisions before and after the review, so a client can tell whether anything besides the
  // review changed the item since its own copy. Rows stored before these columns have neither.
  const reviewItemColumns = db.prepare(`PRAGMA table_info(review_event_items)`).all() as { name: string }[];
  if (!reviewItemColumns.some(column => column.name === 'base_revision')) {
    db.exec(`ALTER TABLE review_event_items ADD COLUMN base_revision INTEGER`);
  }
  if (!reviewItemColumns.some(column => column.name === 'applied_revision')) {
    db.exec(`ALTER TABLE review_event_items ADD COLUMN applied_revision INTEGER`);
  }

  // Migration: add project column to items if missing
  try {
    if (!columns.some(c => c.name === 'project')) {
      db.exec(`ALTER TABLE items ADD COLUMN project TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_project ON items(project)`);
  } catch (e) {
    console.warn('Project column migration:', e);
  }

  // Projects table
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
  } catch (e) {
    console.warn('Projects table creation:', e);
  }

  // Image storage: base64 data URIs live here, OUT of items.data, so item reads/writes
  // never touch image bytes. Keyed by id — a SHARED keyspace for both top-level item ids
  // and nested phrase-vocab ids (a vocab id can appear as both; see DetailView "save vocab").
  // user_id mirrors items.user_id (nullable for legacy orphan rows, claimed on first signup).
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS item_images (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      data TEXT NOT NULL,
      updated_at INTEGER
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_item_images_user_id ON item_images(user_id)`);
    const imageColumns = db.prepare(`PRAGMA table_info(item_images)`).all() as { name: string }[];
    if (!imageColumns.some(c => c.name === 'mime_type')) db.exec(`ALTER TABLE item_images ADD COLUMN mime_type TEXT`);
    if (!imageColumns.some(c => c.name === 'content_hash')) db.exec(`ALTER TABLE item_images ADD COLUMN content_hash TEXT`);
    // Cover stripped-item image markers without fetching legacy rows whose data column can still
    // contain a large base64 payload. This keeps the first sync after a restart from blocking Node.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_item_images_user_versions
      ON item_images(user_id, id, content_hash, updated_at)`);
    // Blob cleanup asks whether anything still references a hash; without this it scans every image.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_item_images_content_hash ON item_images(content_hash)`);
    db.exec(`CREATE TABLE IF NOT EXISTS image_blobs (
      content_hash TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  } catch (e) {
    console.warn('item_images table creation:', e);
  }

  // Prepared example-sentence enrichment is global source material, not a user item. Keeping it in a
  // separate lookup table prevents tens of thousands of analyses and images from entering /api/items.
  // Images reuse image_blobs and are linked into a user's item_images row only when that sentence is saved.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sentence_enrichments (
      lookup_hash TEXT PRIMARY KEY,
      source_id TEXT UNIQUE NOT NULL,
      text_hash TEXT NOT NULL,
      source_text TEXT NOT NULL,
      analysis TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      image_content_hash TEXT,
      image_mime_type TEXT,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sentence_enrichments_source_id
      ON sentence_enrichments(source_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sentence_enrichments_image
      ON sentence_enrichments(image_content_hash) WHERE image_content_hash IS NOT NULL`);
  } catch (e) {
    console.warn('sentence_enrichments table creation:', e);
  }

  // Word comparisons: AI-generated side-by-side analyses, kept OUT of the items table (its CHECK
  // constraint only allows vocab/phrase/sentence). Keyed by the normalized word-set (e.g. 'fable|parable')
  // so direction doesn't matter and each pair stores once; surfaced on every involved word's page.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS comparisons (
      key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      words TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, user_id)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_comparisons_user_id ON comparisons(user_id)`);
  } catch (e) {
    console.warn('comparisons table creation:', e);
  }

  // Refresh planner statistics for tables whose indexes changed, bounded so it stays quick on a large file.
  db.pragma('optimize = 0x10002');
}
