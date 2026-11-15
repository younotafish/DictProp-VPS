import { db } from './connection.js';

/**
 * Remove retired project metadata without delaying the HTTP listener. Updating this SQLite table can
 * rewrite large pages on the small VPS, so a single startup UPDATE exceeds the deploy health window.
 * Small transactions yield between batches; reads already omit project and writes force it to NULL.
 */
export async function migrateLegacyProjects(): Promise<void> {
  const batchSize = 50;
  const selectBatch = db.prepare(`
    SELECT rowid AS rid FROM items
    WHERE project IS NOT NULL AND rowid > ?
    ORDER BY rowid LIMIT ${batchSize}
  `);
  const clearProject = db.prepare('UPDATE items SET project = NULL WHERE rowid = ?');
  const clearBatch = db.transaction((rows: Array<{ rid: number }>) => {
    for (const row of rows) clearProject.run(row.rid);
  });
  let lastRowId = 0;
  let cleared = 0;
  for (;;) {
    const rows = selectBatch.all(lastRowId) as Array<{ rid: number }>;
    if (rows.length === 0) break;
    clearBatch(rows);
    cleared += rows.length;
    lastRowId = rows[rows.length - 1].rid;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  db.prepare('DELETE FROM projects').run();
  if (cleared > 0) console.log(`[migrate] cleared ${cleared} legacy project tags`);
}
