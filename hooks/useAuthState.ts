import { useEffect, useState } from 'react';
import { checkAuth, initialAuthState, isSameAuthUser, type AuthState, type AuthUser } from '../services/auth';
import { AUTH_REQUIRED_EVENT } from '../services/http';

export function useAuthState(): AuthState {
  // Auth state: opens with the last-known session, which the server check below confirms or ends.
  const [authState, setAuthState] = useState<AuthState>(initialAuthState);

  useEffect(() => {
    // An unchanged session keeps its state, so confirming it re-renders nothing.
    const applyAuth = ({ user }: { user: AuthUser | null }) => {
      setAuthState(current => !current.loading && isSameAuthUser(current.user, user)
        ? current
        : { user, loading: false });
    };
    checkAuth().then(applyAuth).catch(() => applyAuth({ user: null }));
    const handleAuthRequired = () => { void checkAuth().then(applyAuth); };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);

  return authState;
}
