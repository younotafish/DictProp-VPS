import { useEffect } from 'react';
import { useLatest } from '../hooks/useStableValue';
import { isImeKey } from './keyboardTarget';

/**
 * Escape closes only the topmost open layer — a dialog over the review popup over the search sheet — instead
 * of every open layer, and the view beneath, reacting to the same press. One capture-phase listener, present
 * only while a layer is open, hands Escape to the top layer and stops it there.
 *
 * A layer can open beneath another (the search sheet slides in under the review popup that asked for a
 * search), so each layer gives its z-index: the highest is on top, and the newest among equals.
 */
interface Layer { onEscape: () => void; z: number }
const layers: Layer[] = [];

const topLayer = (): Layer | undefined => {
  let top: Layer | undefined;
  for (const layer of layers) if (!top || layer.z >= top.z) top = layer;
  return top;
};

const onKeyDown = (e: KeyboardEvent) => {
  // Mid-composition, Escape belongs to the input method (it cancels the candidate), not to a layer. Safari reports
  // the Escape that ends a composition with isComposing false and keyCode 229, which isImeKey also catches.
  if (e.key !== 'Escape' || isImeKey(e)) return;
  const top = topLayer();
  if (!top) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  top.onEscape();
};

/** Opens a layer at z-index `z`; the returned function closes it. */
export function pushEscapeLayer(onEscape: () => void, z = 0): () => void {
  const layer: Layer = { onEscape, z };
  layers.push(layer);
  if (layers.length === 1) window.addEventListener('keydown', onKeyDown, true);
  return () => {
    const i = layers.indexOf(layer);
    if (i < 0) return;
    layers.splice(i, 1);
    if (layers.length === 0) window.removeEventListener('keydown', onKeyDown, true);
  };
}

/**
 * Whether a layer above z-index `z` is open. A layer at `z` (the search sheet asks with 55) then leaves its keys,
 * not only Escape, to the one on top. A layer that opened beneath never counts.
 */
export const hasEscapeLayerAbove = (z: number): boolean => layers.some(layer => layer.z > z);

/** While `active`, Escape calls the latest `onEscape` — unless a layer above this one is open. */
export function useEscapeLayer(onEscape: () => void, z: number, active = true): void {
  const latest = useLatest(onEscape);
  useEffect(() => {
    if (!active) return;
    return pushEscapeLayer(() => latest.current(), z);
  }, [active, z, latest]);
}
