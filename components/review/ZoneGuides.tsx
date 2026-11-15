import type { ZoneFlash } from '../EyesFreeZones';

/**
 * The review popup's eyes-free read-zone guides: a thin bar and a numbered marker on both sides of each live
 * band (the top quarter reads example 1, the second quarter example 2), and a fading tint over a band when a
 * tap lands. Purely visual; taps fall through to the popup's own zone handlers.
 *
 * - 'phone': on the card body's edges, below sm, with the bands as quarters of the body.
 * - 'gutter': in the empty gutters beside the centred card, from sm up, with the bands as quarters of the screen.
 *
 * Its marks are slimmer than EyesFreeZones', which the card view and the search sheet use.
 */
const LAYOUTS = {
  phone: {
    root: 'absolute inset-0 pointer-events-none sm:hidden',
    bands: ['absolute inset-x-0 top-0 h-1/4', 'absolute inset-x-0 top-1/4 h-1/4'],
    bar: 'inset-y-2 w-1',
    barTones: ['bg-indigo-400/60', 'bg-emerald-400/60'],
    markerLeft: 'left-1.5',
    markerRight: 'right-1.5',
    flash: 'w-[28%]',
    flashTones: ['bg-indigo-400/15', 'bg-emerald-400/15'],
    flashKey: '',
  },
  gutter: {
    root: 'fixed inset-0 z-[101] pointer-events-none hidden sm:block',
    bands: ['absolute inset-x-0 top-0 h-[25vh]', 'absolute inset-x-0 top-[25vh] h-[25vh]'],
    bar: 'inset-y-3 w-1.5',
    barTones: ['bg-indigo-400/70', 'bg-emerald-400/70'],
    markerLeft: 'left-2',
    markerRight: 'right-2',
    flash: 'w-16',
    flashTones: ['bg-indigo-400/20', 'bg-emerald-400/20'],
    flashKey: 'g',
  },
} as const;

const MARKER_TONES = ['bg-indigo-100 text-indigo-600', 'bg-emerald-100 text-emerald-600'] as const;
const MARKER = 'top-1/2 -translate-y-1/2 w-5 h-5 rounded-full';
const MARKER_TEXT = 'text-[11px] font-bold flex items-center justify-center shadow-sm';

export function ZoneGuides({ layout, bands, flash }: {
  layout: keyof typeof LAYOUTS;
  /** How many bands are live: 1 when the card has one example, 2 with two or more. */
  bands: number;
  flash: ZoneFlash | null;
}) {
  const style = LAYOUTS[layout];
  return (
    <div className={style.root} aria-hidden="true">
      {([0, 1] as const).filter(zone => zone < bands).map(zone => (
        <div key={zone} className={style.bands[zone]}>
          <div className={`absolute left-0 ${style.bar} rounded-full ${style.barTones[zone]}`} />
          <div className={`absolute right-0 ${style.bar} rounded-full ${style.barTones[zone]}`} />
          <span className={`absolute ${style.markerLeft} ${MARKER} ${MARKER_TONES[zone]} ${MARKER_TEXT}`}>{zone + 1}</span>
          <span className={`absolute ${style.markerRight} ${MARKER} ${MARKER_TONES[zone]} ${MARKER_TEXT}`}>{zone + 1}</span>
          {flash?.zone === zone && (<><div key={`${style.flashKey}l${flash.n}`} className={`absolute left-0 inset-y-0 ${style.flash} ${style.flashTones[zone]} zone-flash`} /><div key={`${style.flashKey}r${flash.n}`} className={`absolute right-0 inset-y-0 ${style.flash} ${style.flashTones[zone]} zone-flash`} /></>)}
        </div>
      ))}
    </div>
  );
}
