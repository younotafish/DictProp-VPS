import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { StoredItem } from '../../types';
import { warn } from '../../services/logger';
import { isTypingTarget } from '../../components/keyboardTarget';
import { extractImageFromTransfer, fileToDataUri, readImageFromSystemClipboard } from './detailUtils';

interface SentenceImageAttachOptions {
  /** The sentence under review, read when an image arrives so it never lands on a sentence already left. */
  currentSentenceRef: RefObject<StoredItem | null>;
  /** Stores and uploads the image and marks the sentence (App's handleAttachSentenceImage). */
  onAttachImage?: (item: StoredItem, base64: string) => Promise<void> | void;
  /** Another layer has the input, so a paste isn't the view's. */
  interactionLocked: boolean;
}

/**
 * Attaching a picture to the sentence under review: pasted anywhere with ⌘V/Ctrl+V, pasted or dropped on the
 * panel, picked from the files, or read from the clipboard with a double tap on the image button.
 */
export function useSentenceImageAttach({ currentSentenceRef, onAttachImage, interactionLocked }: SentenceImageAttachOptions) {
  const [showImagePanel, setShowImagePanel] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageDragOver, setImageDragOver] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageFabTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-sentence image-reload counter. Bumped ONLY when an image is (re)attached, so the OfflineImage
  // key changes on a real image change but NOT on an SRS review (which merely bumps the item's
  // updatedAt). Keying on updatedAt made every "Remember" remount + re-fade the picture — the flash.
  const [imageReloadTick, setImageReloadTick] = useState<Record<string, number>>({});
  // Synchronous re-entrancy guard: a single ⌘V while the panel is focused fires BOTH the window `paste`
  // listener and the panel's onPaste. Setting this synchronously (before the first await) makes the
  // second call in the same dispatch see `true` and bail — so we never double-upload the same image.
  const imageUploadingRef = useRef(false);

  // Convert an image file/blob to base64 and attach it to the CURRENT sentence (read via ref so a stale
  // closure can't target the wrong one). Offload + upload happen in App via onAttachImage.
  const attachImageFromFile = useCallback(async (file: Blob | null) => {
    const target = currentSentenceRef.current;
    if (!file || !target || !onAttachImage) return;
    if (imageUploadingRef.current) return;           // already attaching (or a duplicate same-tick call)
    if (!file.type.startsWith('image/')) { setImageError('That doesn’t look like an image.'); return; }
    imageUploadingRef.current = true;
    setImageError(null);
    setImageUploading(true);
    try {
      const dataUri = await fileToDataUri(file);
      await onAttachImage(target, dataUri);
      // The image for this sentence just changed on disk (IDB) — force just this one to reload now.
      setImageReloadTick(t => ({ ...t, [target.data.id]: (t[target.data.id] ?? 0) + 1 }));
      setShowImagePanel(false);
    } catch (e) {
      warn('Failed to attach sentence image', e);
      setImageError('Couldn’t attach that image. Try again.');
    } finally {
      imageUploadingRef.current = false;
      setImageUploading(false);
    }
  }, [onAttachImage, currentSentenceRef]);

  const pasteImageFromSystemClipboard = useCallback(async () => {
    setImageError(null);
    setShowImagePanel(true);
    if (!navigator.clipboard?.read) {
      setImageError('Direct clipboard access is unavailable. Long-press Paste image instead.');
      return;
    }
    try {
      const image = await readImageFromSystemClipboard();
      if (!image) {
        setImageError('The clipboard does not contain an image.');
        return;
      }
      await attachImageFromFile(image);
    } catch {
      setImageError('Clipboard access was blocked. Long-press Paste image instead.');
    }
  }, [attachImageFromFile]);

  const handleImageFabTap = useCallback(() => {
    if (imageFabTapTimerRef.current) {
      clearTimeout(imageFabTapTimerRef.current);
      imageFabTapTimerRef.current = null;
      void pasteImageFromSystemClipboard();
      return;
    }
    imageFabTapTimerRef.current = setTimeout(() => {
      imageFabTapTimerRef.current = null;
      setImageError(null);
      setShowImagePanel(true);
    }, 400);
  }, [pasteImageFromSystemClipboard]);

  useEffect(() => () => {
    if (imageFabTapTimerRef.current) clearTimeout(imageFabTapTimerRef.current);
  }, []);

  // ⌘V / Ctrl+V anywhere in sentence review attaches a pasted image to the current sentence. Uses the
  // `paste` event (which carries clipboardData). Stands down when a text field is focused, when another
  // overlay owns input, or when the paste has no image (so normal text paste still works everywhere).
  useEffect(() => {
    if (!onAttachImage) return;
    const onPaste = (e: ClipboardEvent) => {
      if (interactionLocked) return;
      if (isTypingTarget(document.activeElement)) return;
      const file = extractImageFromTransfer(e.clipboardData);
      if (!file) return;                              // no image → let the paste proceed normally
      e.preventDefault();
      setShowImagePanel(true);                        // surface the panel so the upload spinner is visible
      void attachImageFromFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onAttachImage, interactionLocked, attachImageFromFile]);

  // Focus the panel card when it opens so an in-panel ⌘V lands on its onPaste handler.
  useEffect(() => {
    if (!showImagePanel || imageUploading) return;
    (document.querySelector('[data-image-panel]') as HTMLElement | null)?.focus();
  }, [showImagePanel, imageUploading]);

  return {
    showImagePanel, setShowImagePanel, imageUploading, imageDragOver, setImageDragOver, imageError, setImageError,
    imageReloadTick, attachImageFromFile, handleImageFabTap,
  };
}
