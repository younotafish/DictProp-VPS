import { useCallback, useEffect, useState } from 'react';
import { loadPrivateEssayCatalog } from '../../services/api/essays';
import { ESSAYS, withPrivateEssays, type Essay } from '../../services/essayCatalog';

export type PrivateCatalogStatus = 'loading' | 'ready' | 'error';

// The essays this page session last loaded, private ones included. A tab that mounts again, after its error
// screen's Try again, shows them at once while it asks the server for the private catalog again.
let loadedEssays: readonly Essay[] = ESSAYS;

/**
 * The essays to show: the public ones, joined by the owner's private ones once the server sends them. The
 * request goes out when the tab mounts and again on `retry`.
 */
export function useEssayCatalog(): { essays: readonly Essay[]; status: PrivateCatalogStatus; retry: () => void } {
  const [essays, setEssays] = useState(() => loadedEssays);
  const [status, setStatus] = useState<PrivateCatalogStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    loadPrivateEssayCatalog()
      .then(source => {
        if (cancelled) return;
        loadedEssays = withPrivateEssays(source);
        setEssays(loadedEssays);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => setAttempt(previous => previous + 1), []);
  return { essays, status, retry };
}
