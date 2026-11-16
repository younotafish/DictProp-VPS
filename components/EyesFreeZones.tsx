import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Visual guide for the "eyes-free" tap zones used across the app: the TOP HALF of a surface is split
 * into two stacked bands — the top quarter reads the 1st example sentence, the second quarter reads the
 * 2nd; the bottom half is inert. The bands are invisible to the user otherwise, so this overlay draws a
 * thin, differently-coloured boundary line + a numbered marker on each so it's obvious which area plays
 * which sentence. Purely decorative: `pointer-events-none` lets every tap fall through to the real
 * zone handler underneath.
 *
 * Anchoring matches the handler that measures the zones:
 *   - 'viewport' → bands are quarters of the SCREEN (DetailView word/phrase taps, measured vs innerHeight).
 *   - 'fill'     → bands are quarters of the nearest positioned ancestor (the search popup body / the
 *                  sentence-review word card, measured vs the element's own rect). Parent must be relative.
 *
 * `flash` re-renders a quick fade-out tint over a band to confirm a tap landed; bump `n` (even for the
 * same zone) to replay the animation.
 */
export interface ZoneFlash {
  zone: number; // 0 = first quarter, 1 = second quarter
  n: number;    // increment on every tap so the animation re-fires
}

// The band a tap lands in (0, 1, or -1 for the inert bottom half); the guide below draws exactly these bands.
export { eyesFreeZoneAt } from './eyesFreeBands';

const FLASH_MS = 500;

/** The tap-confirmation flash for the guide: `flashZone(zone)` shows it over a band for half a second. */
export const useZoneFlash = (): { zoneFlash: ZoneFlash | null; flashZone: (zone: number) => void } => {
  const [zoneFlash, setZoneFlash] = useState<ZoneFlash | null>(null);
  const zoneFlashN = useRef(0);
  const zoneFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashZone = useCallback((zone: number) => {
    zoneFlashN.current += 1;
    setZoneFlash({ zone, n: zoneFlashN.current });
    if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current);
    zoneFlashTimer.current = setTimeout(() => setZoneFlash(null), FLASH_MS);
  }, []);
  useEffect(() => () => { if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current); }, []);
  return { zoneFlash, flashZone };
};

interface Props {
  /** How many bands are live (1 = only the 1st example exists, 2 = both). 0 renders nothing. */
  bands: number;
  anchor: 'viewport' | 'fill';
  flash?: ZoneFlash | null;
}

const ZONE = [
  { bar: 'bg-indigo-400', tint: 'bg-indigo-400/25' },
  { bar: 'bg-emerald-400', tint: 'bg-emerald-400/25' },
] as const;

export const EyesFreeZones: React.FC<Props> = ({ bands, anchor, flash }) => {
  if (bands < 1) return null;
  // The overlay always covers the top HALF of the reference box; each band is half of that (a quarter
  // of the box), exactly matching eyesFreeZoneAt's split.
  const root =
    anchor === 'viewport'
      ? 'fixed inset-x-0 top-0 h-[50dvh]'
      : 'absolute inset-x-0 top-0 h-1/2';

  return (
    <div className={`${root} z-30 pointer-events-none select-none`} aria-hidden="true">
      {[0, 1].map((z) => {
        if (z + 1 > bands) return null;
        const C = ZONE[z];
        return (
          <div
            key={z}
            className="absolute inset-x-0 h-1/2"
            style={{ top: z === 0 ? 0 : '50%' }}
          >
            {/* accent bars on BOTH edges — frame the band without covering the card content */}
            <div className={`absolute left-0 top-1.5 bottom-1.5 w-1 rounded-full ${C.bar} opacity-80`} />
            <div className={`absolute right-0 top-1.5 bottom-1.5 w-1 rounded-full ${C.bar} opacity-80`} />
            {/* tap/click confirmation — quick fade-out tint, re-keyed so repeat taps replay it */}
            {flash && flash.zone === z && (
              <div key={flash.n} className={`absolute inset-0 ${C.tint} zone-flash`} />
            )}
          </div>
        );
      })}
    </div>
  );
};
