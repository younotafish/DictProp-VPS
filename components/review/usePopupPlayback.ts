import { useCallback, useEffect, useRef } from 'react';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { speakWord, speakNatural, getPlaybackState, getPlaybackProgress, pauseCurrent, resumeCurrent, acquireKeepAlive, releaseKeepAlive } from '../../services/lazyTts';
import { toggleActionFor } from '../../services/audio/playbackToggle';

/**
 * The review popup's audio: the word and sentence playback it starts, the audio session it holds open while
 * it plays, and the example toggles. `examplesList` is what E reads in turn (the first two examples).
 */
export function usePopupPlayback(examplesList: readonly string[]) {
  const popupPlaybackRef = useRef<ReturnType<typeof speakNatural> | null>(null);

  const speakPopupWord = useCallback((text: string) => {
    const handle = speakWord(text);
    popupPlaybackRef.current = handle;
    return handle;
  }, []);
  const speakPopupNatural = useCallback((text: string, options?: Parameters<typeof speakNatural>[1]) => {
    const handle = speakNatural(text, options);
    popupPlaybackRef.current = handle;
    return handle;
  }, []);

  // Hold the audio session open for the life of this popup (once, on the first playback gesture) so the
  // media route stays "hot" across the word→sentence hop and iOS doesn't re-ramp the route (heard as a
  // fade-in) when the sentence <audio> starts after the word played on the speechSynthesis path.
  const keepAliveHeldRef = useRef(false);
  const holdKeepAlive = useCallback(() => {
    if (keepAliveHeldRef.current) return;
    keepAliveHeldRef.current = true;
    acquireKeepAlive();
  }, []);
  useEffect(() => () => { if (keepAliveHeldRef.current) releaseKeepAlive(); }, []);

  // Toggle natural-voice playback for one sentence (same clip → pause / resume / restart-near-end).
  const toggleSpeak = useCallback((raw: string) => {
    const sentence = stripSentenceMarkers(raw || '').trim();
    if (!sentence) return;
    holdKeepAlive();
    switch (toggleActionFor(getPlaybackState(), sentence, getPlaybackProgress(), { onLoading: 'ignore', restartNearEnd: true })) {
      case 'ignore': case 'cancel': return; // already starting this one
      case 'resume': resumeCurrent(); return;
      case 'pause': pauseCurrent(); return;
      case 'restart': case 'start': speakPopupNatural(sentence, { allowDownload: true });
    }
  }, [holdKeepAlive, speakPopupNatural]);

  // E: read both example sentences in turn; press again to pause / resume.
  const readBothExamples = useCallback(() => {
    if (!examplesList.length) return;
    holdKeepAlive();
    const pb = getPlaybackState();
    if (pb.text && examplesList.includes(pb.text) && (pb.status === 'playing' || pb.status === 'paused')) {
      if (pb.status === 'playing') pauseCurrent(); else resumeCurrent();
      return;
    }
    let i = 0;
    let handle: ReturnType<typeof speakNatural> | undefined;
    const playNext = () => {
      if (i >= examplesList.length) return;
      if (handle && !handle.isActive()) return;
      handle = speakPopupNatural(examplesList[i++], { allowDownload: true, onEnd: () => setTimeout(playNext, 400), onError: () => setTimeout(playNext, 400) });
    };
    playNext();
  }, [examplesList, holdKeepAlive, speakPopupNatural]);

  // Do not stop a sentence that was already playing beneath the popup. The handle is token-scoped,
  // so cleanup only stops audio this popup actually started and is still responsible for.
  useEffect(() => () => { popupPlaybackRef.current?.stop(); }, []);

  return { speakPopupWord, speakPopupNatural, holdKeepAlive, toggleSpeak, readBothExamples };
}
