// File helpers the offline scripts share.
import { copyFileSync, existsSync, linkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

// Writes JSON the way every offline stage hands it on: owner-only (0600), pretty-printed, with a final newline. The
// file is written beside its destination and renamed into place, so an interrupted run never leaves half a file for
// the next stage to read. The caller creates the directory. It is atomic-file.mjs's writeJsonAtomic, under the name
// the scripts import.
export { writeJsonAtomic as writePrivateJson } from './atomic-file.mjs';

/** Stages a file by hard link, or by copy across file systems; a file already at the destination is kept. */
export function linkOrCopy(source, destination) {
  if (existsSync(destination)) return;
  try {
    linkSync(source, destination);
  } catch {
    copyFileSync(source, destination);
  }
}
