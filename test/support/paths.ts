import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's location, not the working directory, so a test file runs from anywhere.
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SERVER_DIR = join(REPO_ROOT, 'server');

/** A path inside the repository. */
export const repoPath = (...segments: string[]): string => join(REPO_ROOT, ...segments);

/** A tracked file's text, by its path from the repository root. */
export const readRepoFile = (relativePath: string): string => readFileSync(repoPath(relativePath), 'utf8');
