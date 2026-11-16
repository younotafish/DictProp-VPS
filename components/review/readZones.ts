import { eyesFreeZoneAt } from '../eyesFreeBands';

/**
 * Where the review popup's eyes-free read zones are. A zone is a band down the side of a surface: the top
 * quarter reads the first example (0) and the second quarter the second (1); the lower half reads nothing.
 */
export type ReadZone = 0 | 1;

/**
 * The band a point `offsetY` below the top of a surface `height` tall falls in, or null in the lower half: the
 * app's one eyes-free split, which the card view and the search sheet use too.
 */
export function readBandAt(offsetY: number, height: number): ReadZone | null {
  const zone = eyesFreeZoneAt(offsetY, height);
  return zone === -1 ? null : zone;
}

/**
 * On the phone sheet, the zones are the card body's outer columns (28% of its width on each side), measured
 * against the body. Null in the middle column or the lower half.
 */
export function edgeZoneAt(
  body: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  x: number,
  y: number,
): ReadZone | null {
  const relX = x - body.left;
  const onSide = relX < body.width * 0.28 || relX > body.width * 0.72;
  return onSide ? readBandAt(y - body.top, body.height) : null;
}

/**
 * From sm up, the zones are the empty gutters left and right of the centred card, measured against the
 * screen. Null over the card's columns or in the lower half.
 */
export function gutterZoneAt(
  panel: Pick<DOMRect, 'left' | 'right'>,
  viewportHeight: number,
  x: number,
  y: number,
): ReadZone | null {
  const inGutter = x < panel.left || x > panel.right;
  return inGutter ? readBandAt(y, viewportHeight) : null;
}
