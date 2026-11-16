import React, { useState } from 'react';
import { NoticePill } from './NoticePill';
import { getItemContentHash } from '../services/itemHash';
import { stripSentenceMarkers } from '../services/sentenceMarkers';
import { getItemTitle, type StoredItem } from '../types';

/**
 * The notice in the stack (components/AppStatus) about changes the server refused, which stay on this device. App
 * renders it only while there are some (useLibrary's refusedChanges), and its code loads after the first screen, so
 * none of it is in the app's first chunk.
 */

/** The most characters of an item's title the notice quotes, so the rest of it fits a phone's three lines. */
const QUOTED_TITLE_LIMIT = 20;

/**
 * `title` cut short past QUOTED_TITLE_LIMIT characters, ending in an ellipsis: after its last whole word that fits, or
 * at the limit when that would leave less than half of it.
 */
const clipTitle = (title: string): string => {
  const chars = Array.from(title);
  if (chars.length <= QUOTED_TITLE_LIMIT) return title;
  const head = chars.slice(0, QUOTED_TITLE_LIMIT + 1).join('');
  const space = head.lastIndexOf(' ');
  return `${space >= QUOTED_TITLE_LIMIT / 2 ? head.slice(0, space) : chars.slice(0, QUOTED_TITLE_LIMIT).join('')}…`;
};

/**
 * The notice's words: one item by its title (a sentence's read without its markers, as on the undo pill), several by
 * how many. `full` is the whole of it, when the title had to be cut short.
 */
const describeRefusedChanges = (items: readonly StoredItem[]): { text: string; full?: string } => {
  const title: unknown = items.length === 1 ? getItemTitle(items[0]) : '';
  // The server refuses an item it finds malformed, whose title can be missing, or not text at all.
  const name = typeof title === 'string' ? stripSentenceMarkers(title).replace(/\s+/g, ' ').trim() : '';
  if (!name) {
    return {
      text: items.length === 1
        ? '1 change stays on this device: the server refused it'
        : `${items.length} changes stay on this device: the server refused them`,
    };
  }
  const say = (quoted: string) => `“${quoted}” stays on this device: the server refused it`;
  const clipped = clipTitle(name);
  return clipped === name ? { text: say(name) } : { text: say(clipped), full: say(name) };
};

/** The pill for the refused changes `items`, whose × calls `onDismiss`. */
export const RefusedChangesPill: React.FC<{ items: readonly StoredItem[]; onDismiss: () => void }> = ({ items, onDismiss }) => {
  const { text, full } = describeRefusedChanges(items);
  return (
    <NoticePill
      tone="amber"
      wrap
      title={full}
      label={full}
      actions={[{ label: 'Dismiss the refused changes notice', title: 'Dismiss', dismiss: true, onClick: onDismiss }]}
    >
      {text}
    </NoticePill>
  );
};

const NOTHING_DISMISSED: ReadonlySet<string> = new Set();

/**
 * Whether a notice about the refusals `keys` shows, and the dismiss for its ×. Dismissed, it stays away while every
 * refusal it would tell of was there when it was dismissed, so another refusal brings it back. The dismissal lasts as
 * long as the notice: App renders it while anything is refused, and a reload starts afresh.
 */
export function useDismissedUntilNew(keys: readonly string[]): { shown: boolean; dismiss: () => void } {
  const [dismissed, setDismissed] = useState(NOTHING_DISMISSED);
  return { shown: keys.some(key => !dismissed.has(key)), dismiss: () => setDismissed(new Set(keys)) };
}

/** A refusal as the notice tells them apart: the item, and the content of it the server refused. */
const refusalKey = (item: StoredItem): string => `${item.data.id}:${getItemContentHash(item)}`;

/**
 * The refused changes `items` (useLibrary's refusedChanges), with a × that hides the notice until the server refuses
 * another change: another item, or an edit of one.
 */
export const RefusedChangesNotice: React.FC<{ items: readonly StoredItem[] }> = ({ items }) => {
  const { shown, dismiss } = useDismissedUntilNew(items.map(refusalKey));
  return shown ? <RefusedChangesPill items={items} onDismiss={dismiss} /> : null;
};
