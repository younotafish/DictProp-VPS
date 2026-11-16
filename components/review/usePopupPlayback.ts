import { useCallback, useEffect, useRef } from 'react';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import {
  speakWord, speakNatural, getPlaybackState, getPlaybackProgress, pauseCurrent, resumeCurrent, acquireKeepAlive, releaseKeepAlive,
  type PlaybackState,
} from '../../services/neuralTts';
import { styleChangeReplay, toggleActionFor } from '../../services/audio/playbackToggle';

/**
 * The review popup's audio: the word and sentence playback it starts, the audio session it holds open while
 * it plays, the example toggles, Space, and the replay when Clear or Casual is clicked. `examplesList` is what E reads
 * in turn (the first two examples); Space reads its first when nothing is playing.
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

  // Space: pauses or resumes the sentence playing, waits for a read still loading, and with nothing playing reads the
  // first example. A sentence near its end pauses too, as Space has it on word cards and in sentence review.
  const togglePlayback = useCallback(() => {
    switch (getPlaybackState().status) {
      case 'playing': pauseCurrent(); return;
      case 'paused': resumeCurrent(); return;
      case 'loading': return;
      case 'idle':
        if (!examplesList[0]) return;
        holdKeepAlive();
        speakPopupNatural(examplesList[0], { allowDownload: true });
    }
  }, [examplesList, holdKeepAlive, speakPopupNatural]);

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

  // Clear or Casual, clicked (SpeechStyleToggle's onStyleClicked): one of the popup's `examples` that was playing or
  // loading starts again from its top in the new voice, inside the click, where iOS lets it, and is still the popup's
  // to stop. The engine has already stopped it. A paused one stays stopped, and any other sentence (one auto-play
  // reads under the popup, say) is left to whoever started it.
  const replayInNewStyle = useCallback((before: PlaybackState, examples: readonly string[]) => {
    if (styleChangeReplay(before.status) !== 'replay' || !before.text || !examples.includes(before.text)) return;
    holdKeepAlive();
    speakPopupNatural(before.text, { allowDownload: true });
  }, [holdKeepAlive, speakPopupNatural]);

  // Do not stop a sentence that was already playing beneath the popup. The handle is token-scoped,
  // so cleanup only stops audio this popup actually started and is still responsible for.
  useEffect(() => () => { popupPlaybackRef.current?.stop(); }, []);

  return { speakPopupWord, holdKeepAlive, toggleSpeak, togglePlayback, readBothExamples, replayInNewStyle };
}
