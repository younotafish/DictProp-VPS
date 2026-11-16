import React from 'react';
import { Loader2, X } from 'lucide-react';

/** A notice's colour, for what it reports: dark for news, indigo for work in progress, emerald done, amber a warning, rose a failure. */
export type NoticeTone = 'dark' | 'indigo' | 'emerald' | 'amber' | 'rose';

/** A button on a notice: a text action such as Undo or Reload, or with `dismiss` a round × that closes or stops. */
export interface NoticeAction {
  /** The button's text; a dismiss button's accessible name. */
  label: string;
  onClick: () => void;
  dismiss?: boolean;
  title?: string;
  disabled?: boolean;
  /** The keys that press it too, for assistive technology (aria-keyshortcuts). */
  keyShortcuts?: string;
}

const TONES: Record<NoticeTone, string> = {
  dark: 'bg-slate-800', indigo: 'bg-indigo-600', emerald: 'bg-emerald-600', amber: 'bg-amber-600', rose: 'bg-rose-600',
};

export interface NoticePillProps {
  tone: NoticeTone;
  /** 'alert' for a failure that needs attention; a status otherwise. */
  role?: 'status' | 'alert';
  spinner?: boolean;
  icon?: React.ReactNode;
  /** How far the work has got, from 0 to 1, drawn as a small bar after the text. */
  progress?: number;
  /** The text may take a second line instead of truncating. */
  wrap?: boolean;
  title?: string;
  /** The notice's accessible name, when its text shortens a longer sentence. */
  label?: string;
  children: React.ReactNode;
  actions?: readonly NoticeAction[];
}

/**
 * One notice in the app's notice stack (components/AppStatus). It never grows wider than the screen less 9rem, so
 * the search button's column beside the centred stack stays clear: a longer text truncates, or with `wrap` takes a
 * second line.
 */
export const NoticePill: React.FC<NoticePillProps> = ({
  tone, role = 'status', spinner, icon, progress, wrap, title, label, children, actions = [],
}) => {
  // On the dark pill the text actions are indigo and the × slate; on a coloured one both stay light.
  const dark = tone === 'dark';
  return (
    <div
      role={role}
      title={title}
      aria-label={label}
      className={`pointer-events-auto max-w-[calc(100vw-9rem)] ${wrap ? 'rounded-2xl' : 'rounded-full'} ${TONES[tone]} text-white shadow-xl ${actions.length > 0 ? 'pl-4 pr-1.5 py-1.5' : 'px-4 py-2'} flex items-center gap-2 text-sm font-medium fade-in`}
    >
      {spinner && <Loader2 size={16} className="animate-spin shrink-0" />}
      {icon}
      <span className={`min-w-0 ${wrap ? 'line-clamp-2' : 'truncate'}`}>{children}</span>
      {progress !== undefined && (
        <span className="w-10 h-1.5 shrink-0 rounded-full overflow-hidden bg-white/30">
          <span className="block h-full bg-white transition-all duration-300" style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
      {/* By position, so Reload that turns into Saving… stays the same button. */}
      {actions.map((action, index) => (
        <button
          key={index}
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.title}
          aria-label={action.dismiss ? action.label : undefined}
          aria-keyshortcuts={action.keyShortcuts}
          className={action.dismiss
            ? `shrink-0 w-8 h-8 rounded-full flex items-center justify-center hover:text-white ${dark ? 'text-slate-400 hover:bg-white/10' : 'text-white/75 hover:bg-white/15'}`
            : `shrink-0 rounded-full px-3 py-1 font-semibold disabled:opacity-70 ${dark ? 'text-indigo-300 hover:bg-white/10' : 'hover:bg-white/15'}`}
        >
          {action.dismiss ? <X size={15} /> : action.label}
        </button>
      ))}
    </div>
  );
};
