import { useEscapeLayer } from '../../components/escapeStack';
import { useAnyOverlayOpen } from '../../components/overlayStack';

/**
 * Esc on a reading screen, an essay or a Real Life collection, calls `onEscape` while nothing covers the screen. A
 * lesson, the word popup or a dialog over it takes Esc first: through its own escape layer once it has mounted, and
 * before that, behind its loading spinner or on its crash screen, through App's Escape, which closes it. The screen's
 * layer stands down while any overlay is open (components/overlayStack), so that Esc never closes the screen underneath.
 */
export function useReadingEscape(onEscape: () => void): void {
  useEscapeLayer(onEscape, 0, !useAnyOverlayOpen());
}
