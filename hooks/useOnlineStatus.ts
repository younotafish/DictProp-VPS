import { useEffect, useState } from 'react';

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

  // The banner waits out a brief drop, so a phone losing its signal for a moment doesn't push the page
  // down and back up.
  const [showOfflineBanner, setShowOfflineBanner] = useState(!navigator.onLine);
  useEffect(() => {
    if (isOnline) {
      setShowOfflineBanner(false);
      return;
    }
    const timer = window.setTimeout(() => setShowOfflineBanner(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [isOnline]);

  return { isOnline, showOfflineBanner };
}
