import { createHash, randomUUID } from 'crypto';
import { db } from './connection.js';

// ─── User / Session prepared statements ───

const userStmts = {
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
  getUser: db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `),
  delete: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  deleteExpired: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
};

// The first user claims the rows a single-user database held before accounts existed.
const orphanStmts = {
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

// ─── User CRUD ───

export function findUserByGoogleId(googleId: string): UserRow | null {
  return (userStmts.findByGoogleId.get(googleId) as UserRow) || null;
}

export function getUserCount(): number {
  return (userStmts.count.get() as { cnt: number }).cnt;
}

export const createUserAndClaimItems = db.transaction((opts: {
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

// ─── Session CRUD ───

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const sessionTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createSession(userId: string): { token: string; expiresAt: number } {
  const token = randomUUID();
  const now = Date.now();
  const expiresAt = now + THIRTY_DAYS_MS;
  sessionStmts.create.run({ token: sessionTokenHash(token), user_id: userId, created_at: now, expires_at: expiresAt });
  return { token, expiresAt };
}

let lastSessionCleanup = 0;
export function getSessionUser(token: string): UserRow | null {
  // Periodically clean expired sessions (at most once per hour)
  const now = Date.now();
  if (now - lastSessionCleanup > 3600_000) {
    sessionStmts.deleteExpired.run(now);
    lastSessionCleanup = now;
  }
  // Only the hash of a cookie is ever looked up, so a copy of the sessions table can't be replayed as a cookie.
  return (sessionStmts.getUser.get(sessionTokenHash(token), now) as UserRow | undefined) || null;
}

export function deleteSession(token: string) {
  sessionStmts.delete.run(sessionTokenHash(token));
}
