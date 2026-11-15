// What a script that reads or writes the live database does first and last: find the owner's account, and, after an
// import, fold its writes into the database file and report them.
import { listAllUsers, type UserRow } from '../../db.js';
import { env } from '../../env.js';
import { checkpointAfterWrite } from '../../import-support.js';
import { isOwnerUser } from '../../owner-access.js';

/** The owner's account, which every script reads and writes for. Pass `users` when the caller has already read them. */
export function requireOwner(users: readonly UserRow[] = listAllUsers()): UserRow {
  const owner = users.find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
  if (!owner) throw new Error('Owner account not found');
  return owner;
}

/**
 * Ends an import: folds its writes into the database file, then prints its report and the backup it took as one JSON
 * line, the last of its output. Recorded errors exit 1, so the publisher retries the bundle; stale entries alone
 * don't fail the run.
 */
export function finishImport(result: object & { errors?: readonly unknown[] }, backup: string): void {
  checkpointAfterWrite();
  process.stdout.write(`${JSON.stringify({ ...result, backup })}\n`);
  if (result.errors && result.errors.length > 0) process.exitCode = 1;
}
