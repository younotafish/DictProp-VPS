import React, { Activity, Suspense, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useFrozenWhile } from '../hooks/useStableValue';

const screenFallback = <div className="h-full grid place-items-center"><Loader2 className="animate-spin text-indigo-500" /></div>;

/**
 * A tab's screen. Once opened it stays mounted, hidden while another tab shows, so switching back is
 * instant and finds the tab as it was left: the same scroll position, search, filters and study session.
 * While hidden it keeps the element it last showed, so library changes don't re-render a screen no one
 * sees; it catches up when it shows again.
 */
export function TabScreen({ shown, children }: { shown: boolean; children: React.ReactNode }) {
  const [opened, setOpened] = useState(shown);
  if (shown && !opened) setOpened(true);
  const content = useFrozenWhile(children, !shown);
  if (!opened) return null;
  return (
    <Activity mode={shown ? 'visible' : 'hidden'}>
      <Suspense fallback={screenFallback}>{content}</Suspense>
    </Activity>
  );
}
