import React, { useState } from 'react';
import { X } from 'lucide-react';
import { dismissUpdate, reloadApp, useAppUpdate } from '../services/appUpdate';

/** Offers the reload a deploy calls for. Reloading saves and sends unsent changes first, so it can take a moment. */
export const AppUpdateToast: React.FC = () => {
  const reason = useAppUpdate();
  const [reloading, setReloading] = useState(false);
  if (!reason) return null;
  return (
    <div role="status" className="pointer-events-auto max-w-[calc(100vw-2rem)] bg-slate-800 text-white rounded-full shadow-xl pl-4 pr-1.5 py-1.5 flex items-center gap-2 text-sm font-medium fade-in">
      <span className="truncate">{reason === 'chunk-load' ? 'Part of the app couldn’t load' : 'A new version is available'}</span>
      <button
        onClick={() => { setReloading(true); void reloadApp(); }}
        disabled={reloading}
        className="shrink-0 rounded-full px-3 py-1 font-semibold text-indigo-300 hover:bg-white/10 disabled:opacity-70"
      >
        {reloading ? 'Saving…' : 'Reload'}
      </button>
      {!reloading && (
        <button
          onClick={dismissUpdate}
          className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10"
          title="Not now"
          aria-label="Dismiss the update notice"
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
};
