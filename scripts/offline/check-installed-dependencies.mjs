#!/usr/bin/env node
// Checks that a tree's installed packages are the ones its package-lock.json locks, so code never runs against
// dependencies its lockfile does not describe.
//
// Usage: node scripts/offline/check-installed-dependencies.mjs <tree>...
//
// A tree is a folder holding package-lock.json, such as the repository root or server. Every package the lockfile
// places under node_modules must be installed at its locked version, read from the installed package.json. One the
// lockfile marks optional or devOptional may be missing, since npm skips the platform packages that don't fit the
// machine. Packages installed but not locked are ignored, and a folder without package-lock.json passes.
//
// Exits 0 when every tree matches, and 1 when one differs, printing a line for each such tree that names up to five
// differences. Exits 2 when it can't check: no tree given, or a lockfile it can't read or that lists no packages.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SHOWN_DIFFERENCES = 5;

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** The version in the package.json installed at `folder`, '' when it names none, or null when there is none. */
function installedVersion(folder) {
  try {
    return String(readJson(join(folder, 'package.json')).version ?? '');
  } catch {
    return null;
  }
}

/** What differs between the tree's node_modules and the lockfile's packages, one phrase per package. */
function differences(tree, packages) {
  const found = [];
  for (const [key, locked] of Object.entries(packages)) {
    // The root package ('') and any workspace folder are the project itself, not installed packages.
    if (!/(?:^|\/)node_modules\//.test(key)) continue;
    const name = key.replace(/^node_modules\//, '');
    const installed = installedVersion(join(tree, key));
    if (installed === null) {
      if (!locked.optional && !locked.devOptional) found.push(`${name} is missing`);
    } else if (locked.version !== undefined && installed !== locked.version) {
      found.push(`${name} is ${installed || 'unversioned'}, locked at ${locked.version}`);
    }
  }
  if (found.length > 0 && !existsSync(join(tree, 'node_modules'))) return ['there is no node_modules folder'];
  return found;
}

/** Checks each tree and returns the exit status. */
function check(trees) {
  if (trees.length === 0) {
    console.error('Usage: check-installed-dependencies.mjs <tree>...');
    return 2;
  }
  let status = 0;
  for (const tree of trees) {
    const lockfile = join(tree, 'package-lock.json');
    let lock;
    try {
      lock = readJson(lockfile);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      console.error(`check-installed-dependencies: ${lockfile}: ${error?.message ?? error}`);
      return 2;
    }
    if (typeof lock?.packages !== 'object' || lock.packages === null) {
      console.error(`check-installed-dependencies: ${lockfile} lists no packages (npm 7 or later writes them)`);
      return 2;
    }
    const found = differences(tree, lock.packages);
    if (found.length === 0) continue;
    status = 1;
    const more = found.length > SHOWN_DIFFERENCES ? `; and ${found.length - SHOWN_DIFFERENCES} more` : '';
    console.log(`node_modules in ${resolve(tree)} does not match its package-lock.json `
      + `(${found.slice(0, SHOWN_DIFFERENCES).join('; ')}${more}); run npm ci there, holding the cycle lock`);
  }
  return status;
}

// Setting the code instead of exiting lets the output reach a pipe in full.
process.exitCode = check(process.argv.slice(2));
