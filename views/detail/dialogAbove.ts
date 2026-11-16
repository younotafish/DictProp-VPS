import { hasEscapeLayerAbove } from '../../components/escapeStack';
import { isDialogOpenOutside } from '../../components/keyboardTarget';

/** The card views' layer: their z-index and the Escape layer they open at it. */
export const CARD_VIEW_LAYER = 50;

/**
 * Whether a dialog over the card view has the keys: one outside the view (so not its own playback panel or menu)
 * while a layer above the view is open, such as the search results (55), the card popup or a dialog (100). A tool
 * sheet beneath the view (45), which a search can open a card over, leaves the keys to the view.
 */
export const isDialogAboveCardView = (root: Element | null): boolean =>
  isDialogOpenOutside(root) && hasEscapeLayerAbove(CARD_VIEW_LAYER);
