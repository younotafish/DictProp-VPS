// The speech cache keys a clip by its sentence with these markers stripped, and the server's backfill strips them
// with the same function before it generates clips, so the client runs the shared one instead of keeping a copy
// that could drift and miss those clips. Client code imports it from here.
export { stripSentenceMarkers } from '../server/src/shared/sentence-markers';
