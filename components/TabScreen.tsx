import React, { Activity, Suspense, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useFrozenWhile } from '../hooks/useStableValue';
import { ErrorBoundary } from './ErrorBoundary';

const screenFallback = <div className="h-full grid place-items-center"><Loader2 className="animate-spin text-indigo-500" /></div>;

/**
 * A tab's screen. Once opened it stays mounted, hidden while another tab shows, so switching back is
 * instant and finds the tab as it was left: the same scroll position, search, filters and study session.
 * While hidden it keeps the element it last showed, so library changes don't re-render a screen no one
 * sees as each one lands. It catches up a second after they stop, so showing it again rarely has to.
 * A screen that fails to render shows its error in place, and the other tabs keep working.
 */
export function TabScreen({ shown, children }: { shown: boolean; children: React.ReactNode }) {
  const [opened, setOpened] = useState(shown);
  if (shown && !opened) setOpened(true);
  const content = useFrozenWhile(children, !shown, 1_000);
  if (!opened) return null;
  return (
    <Activity mode={shown ? 'visible' : 'hidden'}>
      <ErrorBoundary variant="screen" fallbackMessage="This tab hit an unexpected error. Your data is safe, and the other tabs still work.">
        <Suspense fallback={screenFallback}>{content}</Suspense>
      </ErrorBoundary>
    </Activity>
  );
}
