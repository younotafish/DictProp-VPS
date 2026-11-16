import { useCallback, type RefObject } from 'react';
import type { SentenceData, StoredItem } from '../../types';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { useTimedMessage } from '../../hooks/useTimedMessage';
import { copyTextToClipboard } from './detailUtils';

/** Copying the sentence under review to the clipboard (to paste into Meta AI or anywhere), with the icon's brief confirmation. */
export function useSentenceCopy(currentSentenceRef: RefObject<StoredItem | null>) {
  const { message: sentenceCopy, show } = useTimedMessage<'copied' | 'failed'>(1600);
  const handleCopySentence = useCallback(async () => {
    const s = currentSentenceRef.current;                 // read via ref → never a stale sentence
    const text = s ? stripSentenceMarkers((s.data as SentenceData).text || '').trim() : '';
    if (!text) return;
    const copied = await copyTextToClipboard(text);
    show(copied ? 'copied' : 'failed');                   // flip icon → green check, or a red cross if it failed
  }, [currentSentenceRef, show]);
  return { sentenceCopy, handleCopySentence };
}
