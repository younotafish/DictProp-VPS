import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { copyTextToClipboard } from './detailUtils';
import type { SentenceCopyState } from './SentenceHero';

/** Copying the sentence under review to the clipboard (to paste into Meta AI or anywhere), with the icon's brief confirmation. */
export function useSentenceCopy(currentSentenceRef: RefObject<StoredItem | null>) {
  const [sentenceCopy, setSentenceCopy] = useState<SentenceCopyState>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);
  const handleCopySentence = useCallback(async () => {
    const s = currentSentenceRef.current;                 // read via ref → never a stale sentence
    const text = s ? stripSentenceMarkers((s.data as SentenceData).text || '').trim() : '';
    if (!text) return;
    const copied = await copyTextToClipboard(text);
    setSentenceCopy(copied ? 'copied' : 'failed');         // flip icon → green check, or a red cross if it failed
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setSentenceCopy(null), 1600);
  }, [currentSentenceRef]);
  return { sentenceCopy, handleCopySentence };
}
