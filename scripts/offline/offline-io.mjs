// File helpers the offline scripts share.
import { copyFileSync, existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

/**
 * Writes JSON the way every offline stage hands it on: owner-only (0600), pretty-printed, with a final newline. The
 * file is written beside its destination and renamed into place, so an interrupted run never leaves half a file for
 * the next stage to read. The caller creates the directory.
 */
export function writePrivateJson(path, value) {
  const destination = resolve(path);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Stages a file by hard link, or by copy across file systems; a file already at the destination is kept. */
export function linkOrCopy(source, destination) {
  if (existsSync(destination)) return;
  try {
    linkSync(source, destination);
  } catch {
    copyFileSync(source, destination);
  }
}
