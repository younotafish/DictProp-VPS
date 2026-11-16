import { fetchWithin } from './http';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
  isAdmin: boolean;
}

export interface AuthState {
  user: AuthUser | null;
  loading: boolean;
}

/** The session App gates on, and whether one the app had has ended on its own. */
export type AuthGate = AuthState & { expired: boolean };

// Last-known session, cached so the app can render offline (see checkAuth).
const AUTH_USER_KEY = 'vps_auth_user';
const AUTH_CHECK_TIMEOUT_MS = 10_000;
type CachedAuth = { user: AuthUser | null };

function readCachedAuth(): CachedAuth | null {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    if (!raw) return null;
    // Entries an older build wrote also carry a pending flag, which no longer means anything.
    const parsed = JSON.parse(raw) as CachedAuth;
    // A session without an id (a damaged entry) would open someone's library under no name.
    return parsed && parsed.user && typeof parsed.user.id === 'string' ? { user: parsed.user } : null;
  } catch {
    return null;
  }
}

function writeCachedAuth(auth: CachedAuth): void {
  try {
    if (auth.user) localStorage.setItem(AUTH_USER_KEY, JSON.stringify(auth));
    else localStorage.removeItem(AUTH_USER_KEY);
  } catch {
    /* ignore */
  }
}

function clearCachedAuth(): void {
  try {
    localStorage.removeItem(AUTH_USER_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Resolve the current session.
 *  - Online: hit /api/auth/me and cache the result.
 *  - Offline / server unreachable: fall back to the last-known cached user so a
 *    previously-signed-in user can still open the app and use their local (IndexedDB)
 *    data instead of being stuck on the sign-in screen.
 * Only a genuine 401 clears the cached session — a network error or a 5xx (e.g. a
 * redeploy) means "can't verify right now", NOT "logged out", so we keep the cache.
 */
export async function checkAuth(): Promise<{ user: AuthUser | null; offline?: boolean }> {
  const cachedSession = () => {
    const cached = readCachedAuth();
    return cached ? { ...cached, offline: true } : { user: null };
  };
  try {
    // A wedged connection counts as offline rather than holding a first sign-in on the spinner.
    return await fetchWithin('/api/auth/me', undefined, AUTH_CHECK_TIMEOUT_MS, async (res) => {
      if (res.status === 401 || res.status === 403) {
        clearCachedAuth(); // genuinely signed out
        return { user: null };
      }
      // Server reachable but erroring — don't nuke the session; use the cache if present.
      if (!res.ok) return cachedSession();
      const data = await res.json();
      const auth: CachedAuth = { user: data.user ?? null };
      writeCachedAuth(auth);
      return auth;
    });
  } catch {
    // Network failure (offline) — render from the cached session + local data.
    return cachedSession();
  }
}

/**
 * The session to open with: the last-known one when there is one, so launch reads the library without
 * waiting on the network while checkAuth confirms it. Only a first sign-in waits for the server.
 */
export function initialAuthState(): AuthState {
  const cached = readCachedAuth();
  return cached ? { ...cached, loading: false } : { user: null, loading: true };
}

/** Whether two sessions show the same account, so confirming an unchanged session changes nothing. */
export function isSameAuthUser(a: AuthUser | null, b: AuthUser | null): boolean {
  return a === b || (!!a && !!b && a.id === b.id && a.email === b.email && a.displayName === b.displayName &&
    a.photoUrl === b.photoUrl && a.isAdmin === b.isAdmin);
}

/**
 * The gate once a session check answers `user`. The same account changes nothing. A session the app had, whether
 * confirmed or the cached one it opened with, that comes back as none has expired: the server turned it away. A
 * deliberate sign-out reloads the page with no cached session, so it never reads as expired.
 */
export function nextAuthGate(current: AuthGate, user: AuthUser | null): AuthGate {
  if (!current.loading && isSameAuthUser(current.user, user)) return current;
  return { user, loading: false, expired: user === null && (current.expired || current.user !== null) };
}

export function loginRedirect(): void {
  window.location.href = '/api/auth/login';
}

/**
 * Sign out on the server, then reload to the sign-in screen. Resolves false, keeping the session and the
 * page, when the server can't be reached: the server session would outlive a local-only sign-out, and
 * dropping the cached session offline would lock the local library behind a sign-in that needs the network.
 */
export async function logout(): Promise<boolean> {
  try {
    const signedOut = await fetchWithin('/api/auth/logout', { method: 'POST' }, AUTH_CHECK_TIMEOUT_MS, async (res) => res.ok);
    if (!signedOut) return false;
  } catch {
    return false;
  }
  clearCachedAuth(); // drop the offline fallback so we don't resurrect the session
  window.location.reload();
  return true;
}
