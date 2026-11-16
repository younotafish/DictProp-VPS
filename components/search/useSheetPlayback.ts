import { useCallback, useEffect, useRef } from 'react';
import { useZoneFlash } from '../EyesFreeZones';
import {
  acquireKeepAlive, getPlaybackProgress, getPlaybackState, pauseCurrent, releaseKeepAlive, resumeCurrent, speakNatural,
} from '../../services/neuralTts';
import { toggleActionFor } from '../../services/audio/playbackToggle';
import type { SearchMode } from './searchViewing';

/**
 * Playback in the results sheet: the eyes-free zones' tap flash, the audio session held open while the sheet is
 * up, and the example-sentence toggle that Cmd/Ctrl+1–4 and the zones share.
 */
export function useSheetPlayback(mode: SearchMode) {
  // Eyes-free zone tap-confirmation flash (see EyesFreeZones).
  const { zoneFlash, flashZone } = useZoneFlash();

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
  useEffect(() => { if (mode !== 'viewing') letGoKeepAlive(); }, [mode, letGoKeepAlive]);
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
        speakNatural(sentence, { allowDownload: true });
    }
  }, [holdKeepAlive]);

  return { zoneFlash, flashZone, playOrToggleSentence };
}
