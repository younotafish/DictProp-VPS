import { ExternalLink } from 'lucide-react';
import { noteExternalNavigation, type LinkOpening, type LinkTone } from '../services/externalLinks';

// Whole class strings per tone, so Tailwind finds every one of them in the source.
const TONE_CLASSES: Record<LinkTone, string> = {
  emerald: 'text-emerald-600 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 hover:border-emerald-300',
  red: 'text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 hover:border-red-300',
  slate: 'text-slate-700 bg-slate-50 border border-slate-300 hover:bg-slate-100 hover:border-slate-400',
  purple: 'text-purple-700 bg-purple-50 border border-purple-200 hover:bg-purple-100 hover:border-purple-300',
  amber: 'text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 hover:border-amber-300',
  sky: 'text-sky-700 bg-sky-50 border border-sky-200 hover:bg-sky-100 hover:border-sky-300',
  teal: 'text-teal-700 bg-teal-50 border border-teal-200 hover:bg-teal-100 hover:border-teal-300',
};

/** The small coloured chip a card's outside links use. */
export const chipClassName = (tone: LinkTone): string =>
  `inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium ${TONE_CLASSES[tone]} transition-all active:scale-95 shadow-sm`;

const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const;

interface ExternalLinkChipProps {
  href: string;
  label: string;
  title: string;
  /** How the link opens; see LinkOpening for why each exists. */
  opening: LinkOpening;
  className: string;
}

/**
 * A link to an outside site. A tap never reaches the card underneath, and the app saves the library
 * before leaving (noteExternalNavigation).
 */
export function ExternalLinkChip({ href, label, title, opening, className }: ExternalLinkChipProps) {
  if (opening === 'window-open') {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          try {
            noteExternalNavigation();
            window.open(href, '_blank', 'noopener,noreferrer');
          } catch {
            // Never let an outside link crash the app.
          }
        }}
        className={className}
        title={title}
      >
        <ExternalLink size={12} />
        {label}
      </button>
    );
  }
  return (
    <a
      href={href}
      {...(opening === 'new-tab' && NEW_TAB)}
      onClick={(e) => {
        e.stopPropagation();
        noteExternalNavigation();
      }}
      className={className}
      title={title}
    >
      <ExternalLink size={12} />
      {label}
    </a>
  );
}
