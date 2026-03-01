import { useEffect } from 'react';

/**
 * Tracks how many YouGlishPlayer instances are currently mounted.
 * Snapshots are taken when the first instance mounts and cleanup
 * runs when the last instance unmounts.
 */
let activeInstances = 0;
let cookieSnapshot: Set<string> | null = null;
let lsSnapshot: Set<string> | null = null;
let ssSnapshot: Set<string> | null = null;

/** Parse cookie string into a Set of cookie names. */
function parseCookieNames(): Set<string> {
  const names = new Set<string>();
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0]?.trim();
    if (name) names.add(name);
  }
  return names;
}

/** Attempt to delete a cookie by expiring it across common path/domain combos. */
function deleteCookie(name: string): void {
  const hostname = location.hostname;
  const domains = [hostname, `.${hostname}`, ''];
  const paths = ['/', ''];
  const expired = 'Thu, 01 Jan 1970 00:00:00 GMT';

  for (const domain of domains) {
    for (const path of paths) {
      const domainPart = domain ? `; domain=${domain}` : '';
      const pathPart = path ? `; path=${path}` : '';
      document.cookie = `${name}=; expires=${expired}${domainPart}${pathPart}`;
    }
  }
}

/**
 * Sandboxes browser state around YouGlish widget usage.
 *
 * On first mount: snapshots cookies, localStorage keys, and sessionStorage keys.
 * On last unmount: diffs against snapshots and removes anything YouGlish added,
 * removes the YouGlish script tag, and cleans up window.YG.
 */
export function useYouGlishSandbox(): void {
  useEffect(() => {
    // --- Mount ---
    if (activeInstances === 0) {
      try {
        cookieSnapshot = parseCookieNames();
      } catch (_) {
        cookieSnapshot = new Set();
      }
      try {
        lsSnapshot = new Set(Object.keys(localStorage));
      } catch (_) {
        lsSnapshot = new Set();
      }
      try {
        ssSnapshot = new Set(Object.keys(sessionStorage));
      } catch (_) {
        ssSnapshot = new Set();
      }
    }
    activeInstances++;

    // --- Unmount ---
    return () => {
      activeInstances--;
      if (activeInstances > 0) return;

      // 1. Delete cookies added during the YouGlish session
      try {
        const currentCookies = parseCookieNames();
        for (const name of currentCookies) {
          if (cookieSnapshot && !cookieSnapshot.has(name)) {
            deleteCookie(name);
          }
        }
      } catch (_) { /* best effort */ }

      // 2. Remove localStorage entries added during the session
      try {
        const currentKeys = new Set(Object.keys(localStorage));
        for (const key of currentKeys) {
          if (lsSnapshot && !lsSnapshot.has(key)) {
            localStorage.removeItem(key);
          }
        }
      } catch (_) { /* best effort */ }

      // 3. Remove sessionStorage entries added during the session
      try {
        const currentKeys = new Set(Object.keys(sessionStorage));
        for (const key of currentKeys) {
          if (ssSnapshot && !ssSnapshot.has(key)) {
            sessionStorage.removeItem(key);
          }
        }
      } catch (_) { /* best effort */ }

      // 4. Remove the YouGlish script tag so it loads fresh next time
      try {
        document.querySelector('script[src*="youglish.com"]')?.remove();
      } catch (_) { /* best effort */ }

      // 5. Clean up YouGlish globals
      try {
        delete (window as any).YG;
        delete (window as any).onYouglishAPIReady;
      } catch (_) { /* best effort */ }

      // Reset snapshots
      cookieSnapshot = null;
      lsSnapshot = null;
      ssSnapshot = null;
    };
  }, []);
}
