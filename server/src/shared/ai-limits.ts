// Limits of the server's AI and speech routes that the client has to agree with, in one place for both sides.
// Like everything in server/src/shared it imports nothing (see README.md).

// Each AI request runs inside one overall budget, shared by the first answer, targeted card repairs and a re-ask,
// and it ends early if the client disconnects. DeepSeek-V4-Flash can take well over a minute to write a full
// multi-sense card set ("run down" alone yields 6 full cards, ~74 s clean and more under VPS load). The client
// waits each budget plus 30 s, so the server's own timeout answer, with its message, arrives first.
export const ANALYSIS_BUDGET_MS = 300_000;
// Comparisons run in the background queue and get a larger budget than searches.
export const COMPARE_BUDGET_MS = 600_000;
export const EXTRACT_BUDGET_MS = 240_000;
export const TRANSCRIBE_BUDGET_MS = 30_000;

// POST /api/tts/generate takes at most this many clips per request, so the client sends its sweeps in chunks of
// this size.
export const GENERATE_MAX_ITEMS = 40;
