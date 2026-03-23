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

export async function checkAuth(): Promise<{ user: AuthUser | null; pending: boolean }> {
  const res = await fetch('/api/auth/me');
  if (res.status === 401) return { user: null, pending: false };
  if (!res.ok) return { user: null, pending: false };
  const data = await res.json();
  return { user: data.user, pending: data.pending || false };
}

export function loginRedirect(): void {
  window.location.href = '/api/auth/login';
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.reload();
}
