export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
  isAdmin: boolean;
}

export interface AuthState {
  user: AuthUser | null;
  pending: boolean;
  loading: boolean;
}

// Last-known session, cached so the app can render offline (see checkAuth).
const AUTH_USER_KEY = 'vps_auth_user';
type CachedAuth = { user: AuthUser | null; pending: boolean };

function readCachedAuth(): CachedAuth | null {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedAuth;
    return parsed && parsed.user ? { user: parsed.user, pending: !!parsed.pending } : null;
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
export async function checkAuth(): Promise<{ user: AuthUser | null; pending: boolean; offline?: boolean }> {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401 || res.status === 403) {
      clearCachedAuth(); // genuinely signed out
      return { user: null, pending: false };
    }
    if (!res.ok) {
      // Server reachable but erroring — don't nuke the session; use the cache if present.
      const cached = readCachedAuth();
      return cached ? { ...cached, offline: true } : { user: null, pending: false };
    }
    const data = await res.json();
    const auth: CachedAuth = { user: data.user ?? null, pending: data.pending || false };
    writeCachedAuth(auth);
    return auth;
  } catch {
    // Network failure (offline) — render from the cached session + local data.
    const cached = readCachedAuth();
    return cached ? { ...cached, offline: true } : { user: null, pending: false };
  }
}

export function loginRedirect(): void {
  window.location.href = '/api/auth/login';
}

export async function logout(): Promise<void> {
  clearCachedAuth(); // drop the offline fallback so we don't resurrect the session
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore — still reload so the UI returns to the sign-in screen */
  }
  window.location.reload();
}
