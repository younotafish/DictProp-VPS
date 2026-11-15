import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's location, not the working directory, so a test file runs from anywhere.
export const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const REPO_ROOT = join(SERVER_DIR, '..');

/** A path inside the repository. */
export const repoPath = (...segments: string[]): string => join(REPO_ROOT, ...segments);
