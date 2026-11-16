/**
 * The eyes-free read bands as arithmetic, for the handlers that measure where a tap landed. Imports nothing, so
 * pure modules use it without importing a component; components/EyesFreeZones.tsx draws the same bands and
 * re-exports it.
 */

/**
 * The band a tap lands in, from its distance below the top of the reference box (the screen, or the element
 * the guide fills) and that box's height: 0 for the top quarter, 1 for the second quarter, -1 for the inert
 * bottom half. The guide draws exactly these bands.
 */
export const eyesFreeZoneAt = (offsetY: number, height: number): 0 | 1 | -1 =>
  offsetY < height / 4 ? 0 : offsetY < height / 2 ? 1 : -1;
