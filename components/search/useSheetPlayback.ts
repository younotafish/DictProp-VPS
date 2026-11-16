import { useCallback, useEffect, useRef, useState } from 'react';
import { useZoneFlash } from '../EyesFreeZones';
import {
  acquireKeepAlive, getPlaybackProgress, getPlaybackState, pauseCurrent, releaseKeepAlive, resumeCurrent, speakNatural, speakWord,
} from '../../services/neuralTts';
import { toggleActionFor } from '../../services/audio/playbackToggle';
import { createSheetAudio } from './sheetAudio';
import type { SearchMode } from './searchViewing';

/**
 * Playback in the results sheet: the eyes-free zones' tap flash, the audio session held open while the sheet is up,
 * and the sheet's own audio (see sheetAudio): its word, the example toggle that Cmd/Ctrl+1–4 and the zones share, and
 * E's and Space's reads. Closing the sheet stops the audio it started, and only that.
 */
export function useSheetPlayback(mode: SearchMode) {
  // Eyes-free zone tap-confirmation flash (see EyesFreeZones).
  const { zoneFlash, flashZone } = useZoneFlash();
  const [audio] = useState(() => createSheetAudio({ speakWord, speakNatural }));

  // Hold the audio session open while the results popup is open (once, on the first playback gesture) so
  // the media route stays "hot" across the word→sentence hop and iOS doesn't re-ramp (heard as a fade-in)
  // when the sentence <audio> starts after the word played on the speechSynthesis path. Closing the popup
  // lets go, or the silent keep-alive would run for the rest of the session.
  const keepAliveHeldRef = useRef(false);
  const holdKeepAlive = useCallback(() => {
    if (keepAliveHeldRef.current) return;
    keepAliveHeldRef.current = true;
    acquireKeepAlive();
  }, []);
  const letGoKeepAlive = useCallback(() => {
    if (!keepAliveHeldRef.current) return;
    keepAliveHeldRef.current = false;
    releaseKeepAlive();
  }, []);
  // X, the backdrop, Esc and dismissing the last result all close the sheet through its mode.
  useEffect(() => {
    if (mode === 'viewing') return;
    audio.stop();
    letGoKeepAlive();
  }, [mode, audio, letGoKeepAlive]);
  useEffect(() => letGoKeepAlive, [letGoKeepAlive]);

  // Read an example sentence in the natural voice. A second press on the same sentence pauses or resumes it
  // (or starts it again once it's nearly done), as the DetailView shortcut does.
  const playOrToggleSentence = useCallback((sentence: string) => {
    switch (toggleActionFor(getPlaybackState(), sentence, getPlaybackProgress(), { onLoading: 'ignore', restartNearEnd: true })) {
      case 'ignore': case 'cancel': return; // already starting this one
      case 'resume': resumeCurrent(); return;
      case 'pause': pauseCurrent(); return; // mid-clip
      case 'restart': case 'start':
        holdKeepAlive();
        audio.sentence(sentence, { allowDownload: true });
    }
  }, [holdKeepAlive, audio]);

  // Says a word: on opening a result and on every switch of result or meaning, and on P.
  const speakSheetWord = useCallback((word: string) => audio.word(word), [audio]);

  // E: reads the examples in turn. Pressed again while one of them is the active read, it follows the speaker's rule, as
  // the card view's and the review popup's E do: pause it, resume it, leave it loading, or once 85% of it has played
  // start the run again from the first example.
  const readExamples = useCallback((examples: readonly string[]) => {
    if (examples.length === 0) return;
    holdKeepAlive();
    const state = getPlaybackState();
    if (state.text && examples.includes(state.text)) {
      switch (toggleActionFor(state, state.text, getPlaybackProgress(), { onLoading: 'ignore', restartNearEnd: true })) {
        case 'pause': pauseCurrent(); return;
        case 'resume': resumeCurrent(); return;
        case 'ignore': case 'cancel': return; // still loading
        case 'restart': case 'start': break; // nearly over: the run starts again
      }
    }
    audio.inTurn(examples);
  }, [holdKeepAlive, audio]);

  // Space: the toggle rule on the sentence playing or paused, before anything else (it pauses, resumes, or starts
  // again once it's nearly done), and otherwise reads the first example.
  const togglePlayback = useCallback((firstExample: string | undefined) => {
    const { text, status } = getPlaybackState();
    if (text && (status === 'playing' || status === 'paused')) playOrToggleSentence(text);
    else if (status === 'idle' && firstExample) playOrToggleSentence(firstExample);
  }, [playOrToggleSentence]);

  // Before showing another result or meaning, which then says its own word.
  const stopSheetAudio = useCallback(() => audio.stop(), [audio]);

  return { zoneFlash, flashZone, playOrToggleSentence, speakSheetWord, readExamples, togglePlayback, stopSheetAudio };
}
