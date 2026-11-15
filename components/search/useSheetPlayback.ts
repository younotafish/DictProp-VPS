import { useCallback, useEffect, useRef, useState } from 'react';
import type { ZoneFlash } from '../EyesFreeZones';
import { acquireKeepAlive, releaseKeepAlive } from '../../services/lazyTts';
import type { SearchMode } from './searchViewing';

/** Playback in the results sheet: the eyes-free zones' tap flash, and the audio session held open while it's up. */
export function useSheetPlayback(mode: SearchMode) {
  // Eyes-free zone tap-confirmation flash (see EyesFreeZones).
  const [zoneFlash, setZoneFlash] = useState<ZoneFlash | null>(null);
  const zoneFlashN = useRef(0);
  const zoneFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashZone = useCallback((zone: number) => {
    zoneFlashN.current += 1;
    setZoneFlash({ zone, n: zoneFlashN.current });
    if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current);
    zoneFlashTimer.current = setTimeout(() => setZoneFlash(null), 500);
  }, []);
  useEffect(() => () => { if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current); }, []);

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

  return { zoneFlash, flashZone, holdKeepAlive };
}
