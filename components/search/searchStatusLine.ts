import { readyItemsOf, type QueueItem } from './searchQueue';

/**
 * The search's one status line in the app's notice stack (components/search/SearchStatusPill), worked out from the
 * queue at a given time. Lines that report a moment ("Looking up “gamut”…", a scan's finding) show for a short while,
 * newest first; then a result the sheet hasn't shown ("gamut +2", with View) stays until it's seen or cleared, even
 * while other lookups run; then a scan still running says so. A saved word is answered at once and opens by itself,
 * so it never says it's looking up.
 */

/** How long "Looking up …" and "Still looking up …" show after the request went out or was asked for again. */
export const LOOKUP_LINE_MS = 2000;
/** How long a finished scan's line shows. */
export const SCAN_DONE_LINE_MS = 3500;

export interface SearchStatus {
  kind: 'started' | 'repeat' | 'scan-done' | 'ready' | 'scanning';
  text: string;
  /** ready: the entry View opens in the sheet. */
  viewId?: string;
}

/** A line that reports a moment: it shows from `at` until `until`. */
interface MomentLine {
  at: number;
  until: number;
  status: SearchStatus;
}

const isRunning = (item: QueueItem): boolean => item.status === 'pending' || item.status === 'searching';

const scanDoneText = ({ found = 0, translation }: QueueItem): string => {
  if (found === 0) return 'No advanced expressions in this sentence';
  const noun = found === 1 ? 'expression' : 'expressions';
  return translation ? `“${translation}” — analyzing ${found} ${noun}…` : `Found ${found} ${noun} — analyzing…`;
};

/** Every moment line the queue has reported, whether or not it still shows. */
function momentLines(queue: readonly QueueItem[]): MomentLine[] {
  const lines: MomentLine[] = [];
  for (const item of queue) {
    if (item.kind === 'lookup' && isRunning(item)) {
      // An expression a scan found is reported by the scan's line, not one line each.
      if (item.startedAt !== undefined && !item.scanId) {
        lines.push({ at: item.startedAt, until: item.startedAt + LOOKUP_LINE_MS, status: { kind: 'started', text: `Looking up “${item.query}”…` } });
      }
      if (item.repeatAt !== undefined) {
        lines.push({ at: item.repeatAt, until: item.repeatAt + LOOKUP_LINE_MS, status: { kind: 'repeat', text: `Still looking up “${item.query}”…` } });
      }
    } else if (item.kind === 'scan') {
      if (isRunning(item) && item.startedAt !== undefined) {
        lines.push({ at: item.startedAt, until: item.startedAt + LOOKUP_LINE_MS, status: { kind: 'scanning', text: 'Scanning…' } });
      } else if (item.status === 'ready' && item.finishedAt !== undefined) {
        lines.push({ at: item.finishedAt, until: item.finishedAt + SCAN_DONE_LINE_MS, status: { kind: 'scan-done', text: scanDoneText(item) } });
      }
    }
  }
  return lines;
}

/** What the status line says at `now`, or null when it has nothing to say. */
export function deriveSearchStatus(queue: readonly QueueItem[], now: number): SearchStatus | null {
  let newest: MomentLine | null = null;
  for (const line of momentLines(queue)) {
    if (now < line.until && (!newest || line.at >= newest.at)) newest = line;
  }
  if (newest) return newest.status;

  const unseen = readyItemsOf(queue).filter(item => !item.seen);
  if (unseen.length > 0) {
    const first = unseen[0];
    const label = first.results?.query || first.query;
    return { kind: 'ready', text: unseen.length > 1 ? `${label} +${unseen.length - 1}` : label, viewId: first.id };
  }

  return queue.some(item => item.kind === 'scan' && isRunning(item)) ? { kind: 'scanning', text: 'Scanning…' } : null;
}

/** When a moment line showing at `now` stops showing, the soonest, or null when none will. */
export function nextStatusChangeAt(queue: readonly QueueItem[], now: number): number | null {
  let next: number | null = null;
  for (const { until } of momentLines(queue)) {
    if (until > now && (next === null || until < next)) next = until;
  }
  return next;
}
