import { createHash } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';

/** The SHA-256 of text or bytes, in hex. */
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Pretty-printed JSON with a final newline, as the offline scripts write their files. */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A script (a stub CLI, say) that the code under test can run. */
export function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
