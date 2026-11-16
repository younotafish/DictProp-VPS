/** Where the Essays page was scrolled, and the room the Continue card took above its tiles then: 0 with no card. */
export interface LandingScroll {
  scrollTop: number;
  cardSpace: number;
}

/**
 * The scrollTop that puts the Essays page back as it was left, though the Continue card above the tiles may have come,
 * gone or changed height meanwhile (the essay just left is now unfinished, or finished). `slotTop` is where the card's
 * slot starts down the page and `cardSpace` the room the card takes now. A page left scrolled to the slot or past it
 * moves by the change, so the tiles stay where they were; one left above it, with some of the header in view, comes back
 * as it was, a new card showing under the header.
 */
export function restoredScrollTop(left: LandingScroll, slotTop: number, cardSpace: number): number {
  return left.scrollTop >= slotTop ? Math.max(0, left.scrollTop + cardSpace - left.cardSpace) : left.scrollTop;
}
