import { useEffect, useState } from 'react';
import { OFFLINE_SETTLE_MS } from '../services/connectivityNotice';

/**
 * The connection, two ways. isOnline follows the browser at once, for the actions that need the server. offlineSettled
 * turns true once an outage has lasted OFFLINE_SETTLE_MS, and false the moment it ends, for the chrome (the Offline
 * chip, the controls disabled while offline), so a phone losing its signal for a moment changes nothing on screen.
 * An app opened offline has settled already.
 */
export function useOnlineStatus() {
  // Network status detection for offline support
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const [offlineSettled, setOfflineSettled] = useState(!navigator.onLine);
  useEffect(() => {
    if (isOnline) {
      setOfflineSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setOfflineSettled(true), OFFLINE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [isOnline]);

  return { isOnline, offlineSettled };
}
