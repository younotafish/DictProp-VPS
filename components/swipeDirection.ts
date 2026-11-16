/**
 * The direction of a touch that moved `dx`, `dy` pixels, if it was a sideways swipe: more than `minPx` sideways and
 * more than half again as far sideways as up or down. Null for anything else, a scroll or a tap. The touch handlers
 * that page sideways share this rule, each with its own distance: the Notebook's rows and carousel and the search
 * sheet's meanings 50 px, the review popup and the card view 60 px.
 */
export const swipeDirection = (dx: number, dy: number, minPx = 50): 'left' | 'right' | null => {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (!(absX > absY * 1.5 && absX > minPx)) return null;
  return dx < 0 ? 'left' : 'right';
};
