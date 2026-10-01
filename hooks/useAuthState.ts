import { useEffect, useState } from 'react';
import { checkAuth, initialAuthState, isSameAuthUser, type AuthState, type AuthUser } from '../services/auth';
import { AUTH_REQUIRED_EVENT } from '../services/http';

export function useAuthState(): AuthState {
  // Auth state: opens with the last-known session, which the server check below confirms or ends.
  const [authState, setAuthState] = useState<AuthState>(initialAuthState);

  useEffect(() => {
    // An unchanged session keeps its state, so confirming it re-renders nothing.
    const applyAuth = ({ user, pending }: { user: AuthUser | null; pending: boolean }) => {
      setAuthState(current => !current.loading && current.pending === pending && isSameAuthUser(current.user, user)
        ? current
        : { user, pending, loading: false });
    };
    checkAuth().then(applyAuth).catch(() => applyAuth({ user: null, pending: false }));
    const handleAuthRequired = () => { void checkAuth().then(applyAuth); };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);

  return authState;
}
