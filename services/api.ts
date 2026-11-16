// The server API, by domain, lives in services/api/. These names stay reachable here for the modules that import
// them from this file.
export { loadPrivateEssayCatalog } from './api/essays';
export {
  applyReviewMutation, loadAllItems, loadItemChanges, loadItemChangesSince, loadReviewHistory, saveItems,
  undoReviewMutation,
  type AppliedReviewResponse, type ItemChanges, type ItemChangesSince, type SaveItemsResult, type UndoReviewResponse,
} from './api/library';
export { getServerImageManifest, loadItemImage, loadItemImagesBatch, uploadImages } from './api/images';
export { importJSON } from './api/jsonImport';
export {
  analyzeInput, compareWords, detectVocabulary, transcribeAudio, type DetectedWord, type VocabularyScan,
} from './api/ai';
export { loadComparisons, saveComparisonApi } from './api/comparisons';
export {
  fetchCachedTTS, fetchCachedTTSTimings, getTtsBackfillStatus, requestTTSGeneration, startTtsBackfill, ttsKey,
  type TtsBackfillStatus, type WordTiming,
} from './api/tts';
