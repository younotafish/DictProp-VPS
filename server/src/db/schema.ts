import type Database from 'better-sqlite3';

/** Add a column an older database file lacks: every CREATE TABLE below already has its final columns. */
function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(existing => existing.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Create every table and index, and bring an older database file up to date. Runs before any statement is prepared. */
export function applySchema(db: Database.Database): void {
  // Columns that older files gained by ALTER TABLE come last, in the order those files have them.
  db.exec(`
    -- project is retired and always NULL: nothing reads or writes it. The column stays because an older image's
    -- upsert still names it, so a rollback to that image can write rows.
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('vocab', 'phrase', 'sentence')),
      data TEXT NOT NULL,
      srs TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      updated_at INTEGER,
      is_deleted INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      user_id TEXT,
      project TEXT,
      revision INTEGER NOT NULL DEFAULT 0
    );

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

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('item_revision', 0);
    INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('theme_seq', 0);

    CREATE TABLE IF NOT EXISTS review_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK(item_type IN ('vocab', 'phrase', 'sentence')),
      reviewed_at INTEGER NOT NULL,
      previous_step INTEGER NOT NULL,
      next_step INTEGER NOT NULL,
      rating TEXT NOT NULL DEFAULT 'good',
      task_type TEXT,
      duration_ms INTEGER,
      session_id TEXT,
      undone_at INTEGER
    );

    -- The item's revisions before and after the review, so a client can tell whether anything besides the
    -- review changed the item since its own copy. Rows stored before those columns have neither.
    CREATE TABLE IF NOT EXISTS review_event_items (
      event_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      previous_srs TEXT NOT NULL,
      applied_srs TEXT NOT NULL,
      base_revision INTEGER,
      applied_revision INTEGER,
      PRIMARY KEY (event_id, item_id)
    );

    -- Images live here, out of items.data, so item reads and writes never touch image bytes. Keyed by id, a
    -- keyspace shared by top-level item ids and phrase vocab ids (a vocab id can be both; see DetailView's
    -- "save vocab"). user_id mirrors items.user_id: null for rows from before accounts, claimed at sign-up.
    -- Rows keep their bytes in image_blobs under content_hash and leave data empty; only rows from before
    -- image_blobs hold an inline data URI there.
    CREATE TABLE IF NOT EXISTS item_images (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      data TEXT NOT NULL,
      updated_at INTEGER,
      mime_type TEXT,
      content_hash TEXT
    );

    -- byte_length and created_at sit after the blob: a scan must test length(data), never those columns, or
    -- SQLite reads every overflow page of every image to reach them.
    CREATE TABLE IF NOT EXISTS image_blobs (
      content_hash TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Prepared example-sentence enrichment is global source material, not a user item. A lookup table of its
    -- own keeps tens of thousands of analyses and images out of /api/items. Images reuse image_blobs and are
    -- linked into a user's item_images row only when that sentence is saved.
    CREATE TABLE IF NOT EXISTS sentence_enrichments (
      lookup_hash TEXT PRIMARY KEY,
      source_id TEXT UNIQUE NOT NULL,
      text_hash TEXT NOT NULL,
      source_text TEXT NOT NULL,
      analysis TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      image_content_hash TEXT,
      image_mime_type TEXT,
      updated_at INTEGER NOT NULL
    );

    -- Word comparisons: AI-generated side-by-side analyses, kept out of items, whose CHECK allows only
    -- vocab, phrase and sentence. Keyed by the normalized word set (e.g. 'fable|parable'), so direction
    -- doesn't matter and each set is stored once; every involved word's page shows it.
    CREATE TABLE IF NOT EXISTS comparisons (
      key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      words TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, user_id)
    );

    -- Study signals (shared/study-events.ts): one row per exposure of one of the learner's own sentences in the
    -- sentence lesson, the latest copy the client sent. The columns a ranking model filters by stand alone; the rest
    -- of the event is data, as JSON. Nothing in the app reads them yet.
    CREATE TABLE IF NOT EXISTS study_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      session_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      visible_ms INTEGER NOT NULL,
      got_its INTEGER NOT NULL,
      exit TEXT NOT NULL,
      final INTEGER NOT NULL,
      data TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );

    -- Today's theme for each of the user's own sentences, as the server's classifier chose it (server/src/themes). It
    -- stays out of item data, so labelling takes no item revisions and no corpus import can drop it. seq orders what
    -- GET /api/themes sends: it takes the next value of sync_meta's theme_seq only when the row's theme changes.
    -- input_hash says which input the row is about (the sentence's text), and failures counts the classifier's misses
    -- on that input under taxonomy_version. The sweep deletes the rows of items that aren't sentences, the words it
    -- labelled while Today still took words, without moving theme_seq.
    CREATE TABLE IF NOT EXISTS item_themes (
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      theme_id TEXT,
      input_hash TEXT NOT NULL,
      taxonomy_version INTEGER NOT NULL,
      model TEXT NOT NULL,
      classified_at INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, item_id)
    );
  `);

  addColumnIfMissing(db, 'items', 'user_id', 'TEXT');
  addColumnIfMissing(db, 'items', 'project', 'TEXT');
  addColumnIfMissing(db, 'items', 'revision', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'review_events', 'rating', `TEXT NOT NULL DEFAULT 'good'`);
  addColumnIfMissing(db, 'review_events', 'task_type', 'TEXT');
  addColumnIfMissing(db, 'review_events', 'duration_ms', 'INTEGER');
  addColumnIfMissing(db, 'review_events', 'session_id', 'TEXT');
  addColumnIfMissing(db, 'review_events', 'undone_at', 'INTEGER');
  addColumnIfMissing(db, 'review_event_items', 'base_revision', 'INTEGER');
  addColumnIfMissing(db, 'review_event_items', 'applied_revision', 'INTEGER');
  addColumnIfMissing(db, 'item_images', 'mime_type', 'TEXT');
  addColumnIfMissing(db, 'item_images', 'content_hash', 'TEXT');

  // Primary keys and UNIQUE columns have indexes of their own: the ids, users.google_id, sentence_enrichments.source_id.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_user_revision ON items(user_id, revision, id);
    -- Phrase scans (the owners of an image) read the user's phrase rows, not the library.
    CREATE INDEX IF NOT EXISTS idx_items_user_type ON items(user_id, type);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_review_events_user_time ON review_events(user_id, reviewed_at);
    CREATE INDEX IF NOT EXISTS idx_study_events_user_item ON study_events(user_id, item_id, started_at);
    -- Covers stripped-item image markers without reading legacy rows, whose data column can still hold a
    -- large base64 payload, so the first sync after a restart doesn't block Node.
    CREATE INDEX IF NOT EXISTS idx_item_images_user_versions ON item_images(user_id, id, content_hash, updated_at);
    -- Blob cleanup asks whether anything still references a hash; without this it scans every image.
    CREATE INDEX IF NOT EXISTS idx_item_images_content_hash ON item_images(content_hash);
    CREATE INDEX IF NOT EXISTS idx_sentence_enrichments_image
      ON sentence_enrichments(image_content_hash) WHERE image_content_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_comparisons_user_id ON comparisons(user_id);
    CREATE INDEX IF NOT EXISTS idx_item_themes_user_seq ON item_themes(user_id, seq);
  `);

  // Indexes no statement uses, or that repeat a key or the leading columns of another index. Rolling back to the
  // image deployed before these drops brings back all but two: idx_items_user_id, which it creates only when it
  // adds the user_id column, and idx_review_event_items_event, which it drops as well. Its statements miss
  // neither: idx_items_user_type and idx_items_user_revision lead with user_id, and review_event_items' primary
  // key leads with event_id.
  db.exec(`
    DROP INDEX IF EXISTS idx_items_type;
    DROP INDEX IF EXISTS idx_items_updated;
    DROP INDEX IF EXISTS idx_items_user_id;
    DROP INDEX IF EXISTS idx_users_google_id;
    DROP INDEX IF EXISTS idx_sentence_enrichments_source_id;
    DROP INDEX IF EXISTS idx_item_images_user_id;
    DROP INDEX IF EXISTS idx_review_event_items_event;
  `);

  // The retired projects table, whose index goes with it, and the index the audit counted project tags with. The
  // 2026-11-15 production audit counted no project rows and no tags, and nothing reads either any more. Rolling back to
  // an older image brings both back, empty.
  db.exec(`
    DROP INDEX IF EXISTS idx_items_project;
    DROP TABLE IF EXISTS projects;
  `);

  // Refresh planner statistics for tables whose indexes changed, bounded so it stays quick on a large file.
  db.pragma('optimize = 0x10002');
}
