import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { getItemImageUrl, type SearchResult, type SentenceData, type StoredItem, type VocabCard } from '../../types';
import { OfflineImage } from '../../components/OfflineImage';
import { SentenceAnalysisView } from '../../components/SentenceAnalysisView';
import { SessionPreload, type PreloadSession } from '../../components/SessionPreload';
import { getMasteryColors } from '../../components/mastery';
import { useEscapeLayer } from '../../components/escapeStack';
import { isDialogOpenOutside } from '../../components/keyboardTarget';
import { useOverlay } from '../../components/overlayStack';
import { SRSAlgorithm } from '../../services/srsAlgorithm';
import { analysisPlaceholderState } from '../../services/sentenceAnalysisState';
import { useKeyboardNavigation, useWheelNavigation } from '../../hooks/useKeyboardNavigation';
import { useWarmImages } from '../../hooks/useWarmImages';
import { useLatest } from '../../hooks/useStableValue';
import { ensureTimings, prefetchTTS, preloadAudio, stopCurrent } from '../../services/neuralTts';
import { getTtsStyle, setTtsStyle, type TtsStyle } from '../../services/ttsSettings';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity';
import { preloadSession } from './cardReading';
import { resolveSentenceUnderReview } from './sentenceUnderReview';
import { withSpeechStyle } from './speechStyle';
import { automaticWrite } from './goneItems';
import { lessonReviewPill, memorizedCount, sentenceRowState } from './sentenceRowState';
import { PLATFORM } from '../../services/platform';
import { RememberToast } from './RememberToast';
import { SentenceHero } from './SentenceHero';
import { SentenceHeaderRow } from './SentenceHeaderRow';
import { SentenceActionsRow } from './SentenceActionsRow';
import { SentencePlaybackControls } from './SentencePlaybackControls';
import { SentenceImageFab, SentenceImagePanel } from './SentenceImageAttach';
import { useCardNavigation } from './useCardNavigation';
import { useCommandKeyHeld } from './useCommandKeyHeld';
import { useAutoPlay } from './useAutoPlay';
import { useAutoPlayReader } from './useAutoPlayReader';
import { useSpeechStyle } from './useSpeechStyle';
import { useRememberToast } from './useRememberToast';
import { useSavedSentenceIndex } from './useSavedSentenceIndex';
import { useSentenceEnrichment } from './useSentenceEnrichment';
import { useSentenceImageAttach } from './useSentenceImageAttach';
import { useSentenceCopy } from './useSentenceCopy';
import { useSentencePlayback } from './useSentencePlayback';
import { useExampleSpeech } from './useExampleSpeech';
import { usePassKeysToFocusedControl } from './usePassKeysToFocusedControl';
import { useSentenceActions } from './useSentenceActions';
import { useSentenceGestures } from './useSentenceGestures';
import { useSentenceShortcuts } from './useSentenceShortcuts';
import type { SentenceReviewViewProps } from './types';

/**
 * Sentence review, opened from the Sentences tab, a catalog, or a word card's example: each group is one saved
 * sentence's source card, and sentenceItems[i] is the sentence reviewed at groups[i]. The sentence fills the page
 * with its banner; its analysis is a second page to the right. The source card itself only feeds P, Cmd/Ctrl+1–4
 * and the lock screen's picture.
 */
export function SentenceReviewView({
  groups,
  initialGroupIndex = 0,
  initialItemIndex = 0,
  navigationKey,
  onClose,
  onSave,
  onPatchItem,
  onDelete,
  onResetSRS,
  savedSentenceItems = [],
  onSearch,
  onLazyLoadImage,
  onUpdateSRS,
  onSaveSentence,
  sentenceItems,
  findSaved,
  onOpenCard,
  interactionLocked = false,
  sentencePreviewOnly = false,
  onAttachImage,
}: SentenceReviewViewProps) {
  // The page behind goes inert while a card is open; closing it gives focus back to what opened it.
  useOverlay();

  const { isMobile, isMacDesktop } = PLATFORM;

  // The sentence page's scroller: a long sentence with a picture scrolls in it, and each new sentence starts at its top.
  const heroScrollRef = useRef<HTMLDivElement>(null);

  // State for navigation between sentences (a group each)
  const {
    currentGroupIndex, setCurrentGroupIndex, currentItemIndex, setCurrentItemIndex, currentItem,
  } = useCardNavigation(groups, {
    initialGroupIndex, initialItemIndex, navigationKey, scrollContainerRef: heroScrollRef, sentenceReview: true,
  });

  const [sentencePage, setSentencePage] = useState<'sentence' | 'analysis'>('sentence');
  const rootRef = useRef<HTMLDivElement>(null);
  const isCommandHeld = useCommandKeyHeld(isMacDesktop);
  const {
    isSentenceAutoPlaying, isSentenceAutoPlayingRef, stopAutoPlay, stopSentenceAutoPlay, autoPlayTimerMinutes,
    cycleTimerDuration, countdownStartedAt, sentenceGap, sentenceGapRef, cycleGap, sentenceRepeats, sentenceRepeatsRef,
    cycleRepeats, toggleSentenceAutoPlay,
  } = useAutoPlay();
  const [showSentenceAutoPlayPanel, setShowSentenceAutoPlayPanel] = useState(false);
  const speechStyle = useSpeechStyle();
  const { toast, tryRemember, showRemembered } = useRememberToast();

  const savedSentenceItemsRef = useLatest(savedSentenceItems);
  // Preview lookups run on every render, so index saved sentences once instead of re-normalizing all of them.
  const savedSentenceIndex = useSavedSentenceIndex(savedSentenceItems);
  const savedSentenceIndexRef = useLatest(savedSentenceIndex);
  const onSaveRef = useLatest(onSave);
  const onPatchItemRef = useLatest(onPatchItem);

  // The sentence's source card.
  const data = currentItem.data;
  const type = currentItem.type;

  // Clamp to the (possibly shrunk-by-deletion) list so the shown card AND the "i / N" counter stay valid
  // even when the local index is briefly stale relative to the latest sentenceItems.
  const sentenceIndex = Math.min(currentGroupIndex, sentenceItems.length - 1);
  const currentSentenceSnapshot = sentenceItems[sentenceIndex] ?? null;
  const { preparedSentenceById, preparingSentenceId, failedSentenceIds, sentencePreloadWindow } = useSentenceEnrichment({
    sentenceItems, sentenceIndex, savedSentenceItemsRef, onSaveRef, onPatchItemRef,
  });
  const {
    currentSentence, catalogSentencePreview, catalogPreviewKind, isSentencePreview, sentenceExitLabel,
  } = resolveSentenceUnderReview(
    currentSentenceSnapshot,
    currentSentenceSnapshot ? preparedSentenceById[currentSentenceSnapshot.data.id] : undefined,
    savedSentenceItems,
    text => savedSentenceIndex.byIdentity.get(normalizeSentenceIdentity(text))?.[0],
    sentencePreviewOnly,
  );
  const currentSentenceText = currentSentence ? (currentSentence.data as SentenceData).text : '';
  // The enrichment is fetched for the list's copy of the sentence, so its loading and failure go by that id.
  const analysisLoading = !!currentSentenceSnapshot && preparingSentenceId === currentSentenceSnapshot.data.id;
  const analysisState = analysisPlaceholderState({
    hasAnalysis: !!(currentSentence?.data as SentenceData | undefined)?.analysis,
    loading: analysisLoading,
    failed: !!currentSentenceSnapshot && failedSentenceIds.has(currentSentenceSnapshot.data.id),
  });

  // User-attached image for the sentence under review. Base64 → render directly; a marker
  // ('idb:stored'/'server:has_image') → OfflineImage lazy-loads it by id (IDB, then server).
  const sentenceImageUrl = currentSentence ? getItemImageUrl(currentSentence) : undefined;
  const hasSentenceImage = !!sentenceImageUrl;

  // Refs so the key and gesture handlers read fresh sentence state without re-subscribing. A review or a listen
  // writes its updated sentence to currentSentenceRef at once, so the next one builds on it.
  const currentSentenceRef = useRef(currentSentence);
  useEffect(() => { currentSentenceRef.current = currentSentence; });
  const sentenceItemsRef = useLatest<StoredItem[] | undefined>(sentenceItems);
  const currentGroupIndexRef = useLatest(currentGroupIndex);

  const currentSentenceSpeechStyle = currentSentence
    ? (currentSentence.data as SentenceData).preferredSpeechStyle
    : undefined;
  const currentSentenceId = currentSentence?.data.id;

  // Each saved sentence remembers its own last choice. Sentences without one continue using the
  // persisted global fallback, so existing libraries retain their current behaviour until selected.
  useEffect(() => {
    if (currentSentenceSpeechStyle) setTtsStyle(currentSentenceSpeechStyle);
  }, [currentSentenceId, currentSentenceSpeechStyle]);

  // The writes the view makes on its own, the voice a listen or a style choice leaves, go to the sentence's live record
  // (onPatchItem, which leaves a deleted item alone), so they never bring back a sentence deleted on another device. A
  // Real Life or essay line with no record yet gets one from its first listen, as before; a sentence the library
  // doesn't hold gets nothing.
  const writeSentence = useCallback((sentence: StoredItem, patch: (item: StoredItem) => StoredItem | null) => {
    const id = sentence.data.id;
    const write = automaticWrite({
      live: savedSentenceIndexRef.current.byId.has(id),
      catalogLine: !!(sentence.data as SentenceData).catalogSentenceId,
    });
    if (write === 'skip') return;
    const updated = patch(sentence);
    if (!updated) return;
    currentSentenceRef.current = updated;
    const patchItem = onPatchItemRef.current;
    if (write === 'patch' && patchItem) patchItem(id, patch);
    else onSaveRef.current(updated);
  }, [onPatchItemRef, onSaveRef, savedSentenceIndexRef]);

  const rememberCurrentSentenceSpeechStyle = useCallback((nextStyle: TtsStyle) => {
    const sentence = currentSentenceRef.current;
    if (!sentence || isSentencePreview) return;
    const now = Date.now();
    writeSentence(sentence, item => withSpeechStyle(item, nextStyle, now));
  }, [isSentencePreview, writeSentence]);

  // A sentence heard to its end remembers the voice it was heard in. Nothing is written when it already does, so a
  // listen no longer saves and pushes the sentence each time. An unsaved word-card preview is never saved by a
  // listen; a catalog line, with its stable progress identity, is: its first listen creates its record.
  const handleListened = useCallback((sentence: StoredItem) => {
    const style = getTtsStyle();
    const now = Date.now();
    writeSentence(sentence, item => withSpeechStyle(item, style, now));
  }, [writeSentence]);

  // The bottom row goes by the sentence's reviews, not by whether it has a record, so a first listen that creates a
  // catalog line's record changes nothing on screen. Its memory shows from the first review on.
  const sentenceRow = sentenceRowState({
    catalog: catalogSentencePreview,
    preview: isSentencePreview,
    totalReviews: currentSentence?.srs?.totalReviews ?? 0,
  });
  const sentenceMastery = sentenceRow.showStats && currentSentence?.srs
    ? SRSAlgorithm.getMasteryLevel(currentSentence.srs)
    : null;
  const sentenceMasteryColors = sentenceMastery ? getMasteryColors(sentenceMastery.color) : null;
  // The run's counters, recounted when a review or a sync changes its sentences, so swiping through it never changes
  // them: what's left to review (never reviewed or due) and what's memorized (reviewed and not due).
  const { sentenceMemorizedCount, sentenceReviewPill } = useMemo(() => {
    const now = Date.now();
    return { sentenceMemorizedCount: memorizedCount(sentenceItems, now), sentenceReviewPill: lessonReviewPill(sentenceItems, now) };
  }, [sentenceItems]);

  // A catalog line takes a picture whether or not it has a record yet (attaching one creates it), so the attach button
  // doesn't appear with the first listen. An unsaved example isn't in the library, so it takes none: the button is
  // hidden and a paste is ignored.
  const takesPicture = !!currentSentence && (!isSentencePreview || catalogSentencePreview);
  const {
    showImagePanel, setShowImagePanel, imageUploading, imageDragOver, setImageDragOver, imageError, setImageError,
    imageReloadTick, attachImageFromFile, handleImageFabTap,
  } = useSentenceImageAttach({
    currentSentenceRef,
    onAttachImage: takesPicture ? onAttachImage : undefined,
    interactionLocked,
  });
  const { sentenceCopy, handleCopySentence } = useSentenceCopy(currentSentenceRef);

  const title = type === 'phrase' ? (data as SearchResult).query : (data as VocabCard).word;

  // Warm the CURRENT sentence's audio + word timings so a double-click / Enter seek is reliable.
  // ensureTimings also kicks off background generation if this sentence has no timings yet (whisper
  // cold-start is ~a minute) so they're ready by the time the user goes to seek.
  useEffect(() => {
    if (currentSentenceText) {
      prefetchTTS([currentSentenceText]);
      ensureTimings(currentSentenceText);
    }
  }, [currentSentenceText, speechStyle]);

  // Aggressively stage the next five sentence cards while the learner is reading the current one.
  // Audio (including word timings) is persisted in the dedicated IDB cache; their pictures are warmed below.
  useEffect(() => {
    if (sentencePreloadWindow.length <= 1) return;
    const texts = sentencePreloadWindow.slice(1).map(item => (item.data as SentenceData).text).filter(Boolean);
    const warm = () => { void preloadAudio(texts); };
    warm();
    // A failed warm-up is retried as soon as a flaky connection comes back, even if the learner has
    // stayed on the same sentence throughout the outage.
    window.addEventListener('online', warm);
    return () => window.removeEventListener('online', warm);
  }, [sentencePreloadWindow, speechStyle]);

  // The next five sentences, whose pictures are decoded ahead so each paints on its first frame.
  const upcomingItems = useMemo(() => sentencePreloadWindow.slice(1), [sentencePreloadWindow]);
  useWarmImages(upcomingItems, onLazyLoadImage);

  const handleSentenceAutoPlayFab = useCallback(() => {
    if (!isSentenceAutoPlaying) {
      toggleSentenceAutoPlay();
      setShowSentenceAutoPlayPanel(true);
      return;
    }
    setShowSentenceAutoPlayPanel(open => !open);
  }, [isSentenceAutoPlaying, toggleSentenceAutoPlay]);

  useEffect(() => {
    if (!isSentenceAutoPlaying) setShowSentenceAutoPlayPanel(false);
  }, [isSentenceAutoPlaying]);

  // The session to preload once sentence auto-play starts (see SessionPreload): the saved sentences and
  // their pictures.
  const getPreloadSession = (): PreloadSession => preloadSession(sentenceItems, true);

  const {
    noteListened, readCurrentSentence, toggleSentencePlayback, playFromWordOffset, handleEnterFromSelection,
    goToSentence,
  } = useSentencePlayback({
    currentSentenceRef, sentenceItemsRef, currentGroupIndexRef, isSentenceAutoPlayingRef, stopAutoPlay,
    setCurrentGroupIndex, setCurrentItemIndex, onListened: handleListened,
  });

  useAutoPlayReader({
    active: isSentenceAutoPlaying,
    stop: stopSentenceAutoPlay,
    repeatsRef: sentenceRepeatsRef,
    gapRef: sentenceGapRef,
    groups,
    currentGroupIndex,
    currentItemIndex,
    setCurrentGroupIndex,
    setCurrentItemIndex,
    currentGroupIndexRef,
    currentItem,
    sentenceReview: true,
    sentenceItemsRef,
    readCard: () => ({
      texts: [stripSentenceMarkers(currentSentenceText)].filter(Boolean),
      title: stripSentenceMarkers(currentSentenceText || ''),
      artist: (currentSentence?.data as SentenceData)?.sourceWord || 'DictProp',
    }),
    onRoundListened: noteListened,
  });

  // Fresh ref to the source card so the Cmd/Ctrl+1–4 readers read current data without re-subscribing.
  const currentItemRef = useLatest(currentItem);

  const { speakSentenceAt } = useExampleSpeech({
    currentItemRef, isSentenceAutoPlayingRef, sentenceReview: true, stopAutoPlay,
  });

  // Arrow keys: ←/→ for the two pages and ↑/↓ for sentence navigation. Page changes deliberately leave the
  // shared speech session untouched.
  const navLeft = useCallback(() => setSentencePage('sentence'), []);
  const navRight = useCallback(() => setSentencePage('analysis'), []);
  const navUp = useCallback(() => goToSentence(currentGroupIndexRef.current - 1), [goToSentence, currentGroupIndexRef]);
  const navDown = useCallback(() => goToSentence(currentGroupIndexRef.current + 1), [goToSentence, currentGroupIndexRef]);

  // Sentence review's auto-play is locked on, so leaving it opens the panel with its Stop button.
  const requestSentenceExit = useCallback(() => {
    if (isSentenceAutoPlaying) {
      setShowSentenceAutoPlayPanel(true);
      return;
    }
    onClose();
  }, [isSentenceAutoPlaying, onClose]);

  // Stop any playback when the view closes (covers a manual read still going at close time).
  useEffect(() => () => { stopCurrent(); }, []);

  // Escape closes one thing at a time: an open panel, the analysis page, then the view. A search sheet or
  // dialog above the view takes Escape first.
  useEscapeLayer(() => {
    if (showImagePanel) {
      setShowImagePanel(false);
    } else if (showSentenceAutoPlayPanel) {
      setShowSentenceAutoPlayPanel(false);
    } else if (sentencePage === 'analysis') {
      setSentencePage('sentence');
    } else {
      requestSentenceExit();
    }
  }, 50, !interactionLocked);

  // Keyboard navigation. Cmd+S saves nothing here (the card behind the sentence is its source word), but the
  // hook still keeps it from opening the browser's Save dialog. A sheet or dialog above the view has the keys.
  useKeyboardNavigation({
    onArrowLeft: navLeft,
    onArrowRight: navRight,
    onArrowUp: navUp,
    onArrowDown: navDown,
    onEnter: handleEnterFromSelection,
    guard: () => isDialogOpenOutside(rootRef.current),
    enabled: !interactionLocked,
  });

  usePassKeysToFocusedControl(!interactionLocked);

  // A two-finger sideways swipe on a trackpad flips between the sentence and its analysis, once per swipe, as ←/→ do:
  // it never leaves the view, and scrolling up and down is left alone. The analysis page lies inside the root, so its
  // swipes count too.
  useWheelNavigation({
    containerRef: rootRef,
    onScrollLeft: navLeft,
    onScrollRight: navRight,
    threshold: 80,
    enabled: !interactionLocked,
  });

  const { handleDeleteItem, handleResetSRS, handleRemember } = useSentenceActions({
    currentSentence, currentSentenceRef, isSentencePreview, catalogSentencePreview, onSave, onDelete, onResetSRS,
    onUpdateSRS, tryRemember, showRemembered,
  });

  const {
    onContentTouchStart, onContentTouchEnd, handleMobileWordTouchStart, handleSentenceWordClickCapture,
    handleDoubleClick, handleSentenceSurfaceClick,
  } = useSentenceGestures({
    rootRef, heroScrollRef, isMobile, sentencePage, setSentencePage, isSentenceAutoPlayingRef, setShowSentenceAutoPlayPanel,
    onClose, currentGroupIndexRef, goToSentence, handleRemember, toggleSentencePlayback, playFromWordOffset,
  });

  useSentenceShortcuts({
    enabled: !interactionLocked,
    rootRef,
    title,
    speakSentenceAt,
    readCurrentSentence,
    isSentencePreview,
    catalogSentencePreview,
    handleRemember,
    handleResetSRS,
    handleDeleteItem,
    isSentenceAutoPlaying,
    toggleSentenceAutoPlay,
  });

  // The hero's props, shared by its two layouts (beside an attached picture, or on its own).
  const heroProps: Omit<ComponentProps<typeof SentenceHero>, 'layout'> | null = currentSentence ? {
    text: currentSentenceText,
    sourceWord: (currentSentence.data as SentenceData).sourceWord,
    findSaved,
    onOpenCard,
    onSearchWord: onSearch,
    commandHeld: isCommandHeld,
    onWordTouchStartCapture: isMobile ? handleMobileWordTouchStart : undefined,
    onWordClickCapture: handleSentenceWordClickCapture,
    onListened: () => noteListened(currentSentence.data.id),
    copyState: sentenceCopy,
    onCopy: () => { void handleCopySentence(); },
  } : null;

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 bg-slate-50 flex flex-col shadow-2xl"
    >
      {/* The banner — the saved sentence's "card header": back, the sentence + natural-voice
          speaker, position, and the complete memorization/statistics row. Sits above the scroll area. Its bottom
          padding keeps the row's buttons out of a phone's home-indicator strip. */}
      {currentSentence && (
        <div
          className={`bg-white border-b border-slate-200 px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-sm flex-1 flex flex-col min-h-0`}
          style={{ touchAction: 'manipulation' }}
          onTouchStart={onContentTouchStart}
          onTouchEnd={onContentTouchEnd}
          onClick={handleSentenceSurfaceClick}
          onDoubleClick={handleDoubleClick}
        >
          <div className={`mx-auto w-full ${hasSentenceImage ? 'max-w-3xl lg:max-w-6xl xl:max-w-[1400px]' : 'max-w-3xl'} flex-1 flex flex-col min-h-0`}>
            {/* Row 1: back + position */}
            <SentenceHeaderRow
              autoPlaying={isSentenceAutoPlaying}
              exitLabel={sentenceExitLabel}
              onExit={requestSentenceExit}
              onOpenAnalysis={() => setSentencePage('analysis')}
              loadingLesson={analysisLoading}
              position={sentenceIndex + 1}
              total={sentenceItems.length}
              reviewPill={sentencePreviewOnly ? null : sentenceReviewPill}
            />

            {/* Row 2: the sentence — the hero, filling the page and centered in it. */}
            <div ref={heroScrollRef} className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col">
              <div className="my-auto w-full py-4">
                {hasSentenceImage ? (
                  /* Attached image → responsive side-by-side: image left / sentence right on md+, image
                     stacked on top on phones. On laptops (lg+) the column breaks out wider and the image
                     grows to half-width / taller so it can fill ~half the screen; height-bounded elsewhere. */
                  <div className="flex flex-col md:flex-row md:items-center gap-4 md:gap-6 lg:gap-10 max-w-5xl lg:max-w-none mx-auto w-full px-1">
                    <div data-sentence-image className="w-full md:w-2/5 lg:w-1/2 md:shrink-0 flex justify-center">
                      <div className="w-full max-w-md md:max-w-none rounded-2xl overflow-hidden bg-slate-100 shadow-sm flex items-center justify-center">
                        <OfflineImage
                          key={`${currentSentence.data.id}:${imageReloadTick[currentSentence.data.id] ?? 0}`}
                          src={sentenceImageUrl}
                          itemId={currentSentence.data.id}
                          alt="Attached image for this sentence"
                          onMissing={onLazyLoadImage}
                          className="w-full h-auto max-h-[32vh] md:max-h-[52vh] lg:max-h-[70vh] object-contain"
                          fallbackClassName="w-full aspect-[4/3]"
                        />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      {heroProps && <SentenceHero layout="split" {...heroProps} />}
                    </div>
                  </div>
                ) : (
                  /* No image → the original centered full-width hero, unchanged. */
                  heroProps && <SentenceHero layout="centered" {...heroProps} />
                )}
              </div>
            </div>

            {/* Row 3: memorization stats + actions */}
            <SentenceActionsRow
              srs={currentSentence.srs}
              mastery={sentenceMastery}
              masteryColors={sentenceMasteryColors}
              memorizedCount={sentenceMemorizedCount}
              preview={isSentencePreview}
              catalog={catalogSentencePreview}
              catalogKind={catalogPreviewKind}
              onRemember={handleRemember}
              onSaveSentence={onSaveSentence ? () => {
                const sentence = currentSentence.data as SentenceData;
                onSaveSentence(sentence.text, sentence.sourceWord, sentence.sourceSense, sentence);
              } : undefined}
              onReset={sentenceRow.showReset ? handleResetSRS : undefined}
              onDelete={handleDeleteItem}
            />
          </div>
        </div>
      )}
      {currentSentence && (
        <SentenceAnalysisView
          sentence={currentSentence.data as SentenceData}
          position={sentenceIndex + 1}
          total={sentenceItems.length}
          visible={sentencePage === 'analysis'}
          analysisState={analysisState}
          onBack={() => setSentencePage('sentence')}
          onSearch={onSearch}
          onRemember={isSentencePreview && !catalogSentencePreview ? undefined : handleRemember}
          onTouchStart={onContentTouchStart}
          onTouchEnd={onContentTouchEnd}
          onClick={handleSentenceSurfaceClick}
          onDoubleClick={handleDoubleClick}
        />
      )}

      {/* Whole-session preload indicator (audio + images), bottom-left so it clears the autoplay cluster. */}
      <SessionPreload active={isSentenceAutoPlaying} getSession={getPreloadSession} onLazyLoadImage={onLazyLoadImage} />

      {/* Sentence playback controls. Keep speech style on the primary surface; only Auto-play-specific
          settings belong in the secondary panel. */}
      <SentencePlaybackControls
        onSpeechStyleChange={rememberCurrentSentenceSpeechStyle}
        autoPlaying={isSentenceAutoPlaying}
        onAutoPlayButton={handleSentenceAutoPlayFab}
        showPanel={showSentenceAutoPlayPanel}
        onClosePanel={() => setShowSentenceAutoPlayPanel(false)}
        countdownStartedAt={countdownStartedAt}
        timerMinutes={autoPlayTimerMinutes}
        onCycleTimer={cycleTimerDuration}
        repeats={sentenceRepeats}
        onCycleRepeats={cycleRepeats}
        gap={sentenceGap}
        onCycleGap={cycleGap}
        onStop={() => { stopSentenceAutoPlay(); setShowSentenceAutoPlayPanel(false); }}
      />
      {/* The Remembered! confirmation, shown only while the sentence it confirms is on screen */}
      {toast && toast.id === currentSentence?.data.id && <RememberToast intervalDays={toast.intervalDays} />}

      {/* Attach-image FAB (sentence mode only), in the right rail 4rem above the search button (see SentenceImageFab).
          Hidden while its own paste panel is open. */}
      {takesPicture && !showImagePanel && (
        <SentenceImageFab hasImage={hasSentenceImage} onTap={handleImageFabTap} />
      )}

      {/* Paste / drop / pick panel — mirrors the bottom-right AI-search input overlay. The card is
          focusable + data-image-panel so an in-panel ⌘V lands on onPaste (the window listener is the
          primary path). */}
      {takesPicture && showImagePanel && (
        <SentenceImagePanel
          hasImage={hasSentenceImage}
          uploading={imageUploading}
          dragOver={imageDragOver}
          onDragOverChange={setImageDragOver}
          error={imageError}
          onError={setImageError}
          onClose={() => setShowImagePanel(false)}
          attach={attachImageFromFile}
        />
      )}

    </div>
  );
}
