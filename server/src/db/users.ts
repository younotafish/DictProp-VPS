import { createHash, randomUUID } from 'crypto';
import { SESSION_LIFETIME_MS } from '../session-renewal.js';
import { db, writeTransaction } from './connection.js';

// Accounts and sign-in sessions.

export const userStmts = {
  findByGoogleId: db.prepare(`SELECT * FROM users WHERE google_id = ?`),
  create: db.prepare(`
    INSERT INTO users (id, google_id, email, display_name, photo_url, is_approved, is_admin, created_at)
    VALUES (@id, @google_id, @email, @display_name, @photo_url, @is_approved, @is_admin, @created_at)
  `),
  count: db.prepare(`SELECT COUNT(*) as cnt FROM users`),
  listAll: db.prepare(`SELECT * FROM users ORDER BY created_at`),
};

const sessionStmts = {
  create: db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (@token, @user_id, @created_at, @expires_at)`),
  get: db.prepare(`
    SELECT u.*, s.created_at AS session_created_at, s.expires_at AS session_expires_at
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `),
  // Only ever later, so of two renewals at once the later expiry stays, and never for a session that has expired.
  extend: db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ? AND expires_at < ? AND expires_at > ?`),
  delete: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  deleteExpired: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
};

// The first user claims the rows a single-user database held before accounts existed.
export const orphanStmts = {
  items: db.prepare(`UPDATE items SET user_id = ? WHERE user_id IS NULL`),
  images: db.prepare(`UPDATE item_images SET user_id = ? WHERE user_id IS NULL`),
};

export interface UserRow {
  id: string;
  google_id: string;
  email: string;
  display_name: string | null;
  photo_url: string | null;
  is_approved: number;
  is_admin: number;
  created_at: number;
}

export function findUserByGoogleId(googleId: string): UserRow | null {
  return (userStmts.findByGoogleId.get(googleId) as UserRow) || null;
}

export function getUserCount(): number {
  return (userStmts.count.get() as { cnt: number }).cnt;
}

export const createUserAndClaimItems = writeTransaction((opts: {
  googleId: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
}): UserRow => {
  const isFirstUser = getUserCount() === 0;
  const user: UserRow = {
    id: randomUUID(),
    google_id: opts.googleId,
    email: opts.email,
    display_name: opts.displayName,
    photo_url: opts.photoUrl,
    is_approved: isFirstUser ? 1 : 0,
    is_admin: isFirstUser ? 1 : 0,
    created_at: Date.now(),
  };
  userStmts.create.run(user);
  if (isFirstUser) {
    orphanStmts.items.run(user.id);
    orphanStmts.images.run(user.id);
  }
  return user;
});

export function listAllUsers(): UserRow[] {
  return userStmts.listAll.all() as UserRow[];
}

const sessionTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createSession(userId: string): { token: string; expiresAt: number } {
  const token = randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_LIFETIME_MS;
  sessionStmts.create.run({ token: sessionTokenHash(token), user_id: userId, created_at: now, expires_at: expiresAt });
  // Lookups already ignore expired sessions; a sign-in, which writes anyway, deletes them, so a request writes to the
  // sessions table only to renew one (at most weekly). A busy database never fails a sign-in over this.
  try {
    sessionStmts.deleteExpired.run(now);
  } catch (error) {
    console.warn('Expired sessions were left for the next sign-in:', error instanceof Error ? error.message : error);
  }
  return { token, expiresAt };
}

/** A session that hasn't expired: whose it is, when it was created and when it expires. */
export interface UserSession {
  user: UserRow;
  createdAt: number;
  expiresAt: number;
}

export function getSession(token: string): UserSession | null {
  // Only the hash of a cookie is ever looked up, so a copy of the sessions table can't be replayed as a cookie.
  const row = sessionStmts.get.get(sessionTokenHash(token), Date.now()) as
    (UserRow & { session_created_at: number; session_expires_at: number }) | undefined;
  if (!row) return null;
  const { session_created_at: createdAt, session_expires_at: expiresAt, ...user } = row;
  return { user, createdAt, expiresAt };
}

export function getSessionUser(token: string): UserRow | null {
  return getSession(token)?.user ?? null;
}

/**
 * Move a live session's expiry to `expiresAt` if that is later, and say whether it moved; an expired session stays
 * expired. Best effort: when the database can't take the write (an importer holding it past busy_timeout, say), the
 * session keeps its expiry for a later request to renew, and the request this rides on goes on as if nothing had been
 * asked.
 */
export function extendSession(token: string, expiresAt: number): boolean {
  try {
    return sessionStmts.extend.run(expiresAt, sessionTokenHash(token), expiresAt, Date.now()).changes > 0;
  } catch (error) {
    console.warn('A session renewal was left for a later request:', error instanceof Error ? error.message : error);
    return false;
  }
}

export function deleteSession(token: string) {
  sessionStmts.delete.run(sessionTokenHash(token));
}
