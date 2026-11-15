// Writes that never leave a torn file in place. Each goes to a private temp file beside its target and is
// renamed over it, so a crash leaves the old file or the new one, and a failed write removes its temp file.

import { randomBytes } from 'node:crypto';
import { constants, copyFileSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

function replace(path, writeTemp) {
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeTemp(tempPath);
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function writeFileAtomic(path, data, { mode = 0o600 } = {}) {
  replace(path, tempPath => writeFileSync(tempPath, data, { mode, flag: 'wx' }));
}

// Pretty-printed with a final newline, as the offline scripts write all their JSON.
export function writeJsonAtomic(path, value) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Replacing the destination, rather than writing into it, also leaves alone any other name it is linked to.
export function copyFileAtomic(source, destination) {
  replace(destination, tempPath => copyFileSync(source, tempPath, constants.COPYFILE_EXCL));
}

// Present and not empty: how every stage tells a finished checkpoint or an accepted image.
export function fileReady(path) {
  return existsSync(path) && statSync(path).size > 0;
}
