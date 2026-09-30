import type { SentenceData, StoredItem } from '../../types';

// Helper to format relative time for next review
export const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = timestamp - now;

  if (diff <= 0) return 'now';

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
};

// Format interval days for the "Remembered!" overlay
export const formatNextReview = (days: number): string => {
  if (days <= 1) return 'tomorrow';
  if (days <= 30) return `in ${days} days`;
  const months = Math.round(days / 30 * 2) / 2; // Round to nearest 0.5
  if (months <= 1) return 'in ~1 month';
  return `in ~${months % 1 === 0 ? months.toFixed(0) : months.toFixed(1)} months`;
};

// Read a Blob/File as a base64 data URI (for pasted/picked/dropped sentence images).
export const fileToDataUri = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// Pull the first image out of a clipboard/drop transfer. Safari may expose pasted photos through
// either `items` or `files`, depending on the iOS/iPadOS version and source app.
export const extractImageFromTransfer = (transfer: DataTransfer | null | undefined): File | null => {
  for (const it of Array.from(transfer?.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  for (const file of Array.from(transfer?.files ?? [])) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
};

export const readImageFromSystemClipboard = async (): Promise<Blob | null> => {
  if (!navigator.clipboard?.read) return null;
  const clipboardItems = await navigator.clipboard.read();
  for (const item of clipboardItems) {
    const imageType = item.types.find(type => type.startsWith('image/'));
    if (imageType) return item.getType(imageType);
  }
  return null;
};

// Copy text to the clipboard. Prefers the async Clipboard API (needs HTTPS — dictprop.online is);
// falls back to a hidden-textarea execCommand for older/unsupported contexts. Returns success.
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

export const SENTENCE_PREFETCH_AHEAD = 5;

// Keep this in step with the server's detailed-analysis contract. Older sentence records can have a
// small legacy analysis object; those still need the newer grammar, pronunciation, and evidence pass.
export const hasDetailedSentenceAnalysis = (analysis: SentenceData['analysis']): boolean =>
  !!analysis?.grammar?.structure &&
  !!analysis.pronunciation?.slowIpa &&
  !!analysis.pronunciation.fastIpa &&
  Array.isArray(analysis.pronunciation.fastSpeechFeatures) &&
  analysis.pronunciation.fastSpeechFeatures.length > 0 &&
  Array.isArray(analysis.americanEnglish?.evidence) &&
  analysis.americanEnglish.evidence.length > 0 &&
  Array.isArray(analysis.terms) &&
  analysis.terms.every(term => Array.isArray(term.synonyms) && term.synonyms.length > 0 &&
    Array.isArray(term.examples) && term.examples.length === 2);

export const mergePreparedSentence = (snapshot: StoredItem, prepared?: StoredItem): StoredItem => {
  if (!prepared) return snapshot;
  const liveData = snapshot.data as SentenceData;
  const preparedData = prepared.data as SentenceData;
  const keepLiveAnalysis = hasDetailedSentenceAnalysis(liveData.analysis);
  return {
    ...prepared,
    ...snapshot,
    data: {
      ...preparedData,
      ...liveData,
      analysis: keepLiveAnalysis ? liveData.analysis : (preparedData.analysis ?? liveData.analysis),
      analysisGeneratedAt: keepLiveAnalysis
        ? liveData.analysisGeneratedAt
        : (preparedData.analysisGeneratedAt ?? liveData.analysisGeneratedAt),
      // A user-attached/live item image always wins over prepared source material.
      imageUrl: liveData.imageUrl ?? preparedData.imageUrl,
    },
  };
};

export const serverImageVersion = (imageUrl: string | undefined): string | undefined =>
  imageUrl?.startsWith('server:has_image:')
    ? imageUrl.slice('server:has_image:'.length)
    : undefined;
