// The {{studied item}} and [[uncommon term]] markers that example sentences carry, shared by the client and the
// server so both reduce a sentence to the same speakable text: the speech cache is keyed by that text, so a
// difference would make the client miss the clips the server's backfill made. Like everything in
// server/src/shared it imports nothing (see README.md).

/**
 * Strip the {{studied item}} and [[uncommon term]] emphasis markers, leaving plain,
 * speakable text. Used for TTS (and anywhere the raw sentence is needed without markup).
 */
export const stripSentenceMarkers = (text: string): string =>
  (text || '').replace(/\{\{(.+?)\}\}/g, '$1').replace(/\[\[(.+?)\]\]/g, '$1');
