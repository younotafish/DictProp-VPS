// The speech cache keys a clip by its sentence with these markers stripped, and the server's backfill strips them
// with the same function before it generates clips, so the client runs the shared one instead of keeping a copy
// that could drift and miss those clips. Client code imports it from here.
export { stripSentenceMarkers } from '../server/src/shared/sentence-markers';

/**
 * `text` with the first occurrence of `focus`, matched ignoring case (en-US), wrapped as the {{studied item}} in the
 * text's own spelling; `text` unchanged when `focus` isn't in it. The Real Life and essay catalogs mark each line's
 * focus phrase with it.
 */
export function markItem(text: string, focus: string): string {
  const index = text.toLocaleLowerCase('en-US').indexOf(focus.toLocaleLowerCase('en-US'));
  if (index < 0) return text;
  return `${text.slice(0, index)}{{${text.slice(index, index + focus.length)}}}${text.slice(index + focus.length)}`;
}
