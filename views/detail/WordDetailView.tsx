import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPhraseItem, isVocabItem, type SearchResult, type VocabCard } from '../../types';
import { X } from 'lucide-react';
import { VocabCardDisplay } from '../../components/VocabCard';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { EyesFreeZones } from '../../components/EyesFreeZones';
import { SessionPreload, type PreloadSession } from '../../components/SessionPreload';
import { getMasteryColors } from '../../components/mastery';
import { useEscapeLayer } from '../../components/escapeStack';
import { useOverlay } from '../../components/overlayStack';
import { SRSAlgorithm } from '../../services/srsAlgorithm';
import { useKeyboardNavigation, useWheelNavigation, useWarmImages } from '../../hooks';
import { useLatest } from '../../hooks/useStableValue';
import { prefetchTTS, speakWord, stopCurrent } from '../../services/lazyTts';
import { autoPlayTexts, preloadSession, wordZoneBands as countWordZoneBands } from './cardReading';
import { findSavedCard } from './savedCard';
import { PLATFORM } from './platform';
import { RememberToast } from './RememberToast';
import { DetailActionMenu } from './DetailActionMenu';
import { WordPlaybackControls } from './WordPlaybackControls';
import { WordCardHeader } from './WordCardHeader';
import { MeaningDots } from './MeaningDots';
import { WordComparisons, comparisonsInvolving } from './WordComparisons';
import { PhraseBody } from './PhraseBody';
import { ExampleSentencePreview } from './ExampleSentencePreview';
import { useCardNavigation } from './useCardNavigation';
import { useAutoPlay } from './useAutoPlay';
import { useAutoPlayReader } from './useAutoPlayReader';
import { useSpeechStyle } from './useSpeechStyle';
import { useRememberToast } from './useRememberToast';
import { useSavedSentenceIndex } from './useSavedSentenceIndex';
import { useExampleSentencePreview } from './useExampleSentencePreview';
import { useExampleSpeech } from './useExampleSpeech';
import { usePassKeysToFocusedControl } from './usePassKeysToFocusedControl';
import { useWordActions } from './useWordActions';
import { useWordSlideshow } from './useWordSlideshow';
import { useWordGestures } from './useWordGestures';
import { useWordShortcuts } from './useWordShortcuts';
import type { DetailViewBodyProps } from './types';

/**
 * The word card: one word (a group) at a time, with its meanings (the group's cards) side by side. ↑/↓ move
 * between words and ←/→ between meanings; the header with the card's actions stays hidden until asked for.
 * Auto-play runs a slideshow of the cards, or reads their example sentences; an example opens as a sentence
 * review over the card.
 */
export function WordDetailView(props: DetailViewBodyProps) {
  const {
    groups,
    initialGroupIndex = 0,
    initialItemIndex = 0,
    navigationKey,
    onClose,
    onSave,
    onDelete,
    onArchive,
    onUnarchive,
    onResetSRS,
    savedItems,
    savedSentenceItems = [],
    onSearch,
    onRefresh,
    onLazyLoadImage,
    onUpdateSRS,
    onCompare,
    comparisons,
    onOpenComparison,
    onSaveSentence,
    onOpenExampleSentence,
    isSentenceSaved,
    isVocabSaved,
    onRemoveVocabFromPhrase,
    interactionLocked = false,
  } = props;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // The page behind goes inert while a card is open; closing it gives focus back to what opened it.
  useOverlay();

  // State for 2D navigation
  const {
    currentGroupIndex, setCurrentGroupIndex, currentItemIndex, setCurrentItemIndex, currentGroup, currentItem,
    hasNextGroup, hasPrevGroup, hasPrevItem,
  } = useCardNavigation(groups, { initialGroupIndex, initialItemIndex, navigationKey, scrollContainerRef, sentenceReview: false });

  const [showHeader, setShowHeader] = useState(false); // Hidden by default, shown on short swipe down or H key
  const [showActionMenu, setShowActionMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const moreActionsRef = useRef<HTMLDivElement>(null);
  const {
    isAutoPlaying, isSentenceAutoPlaying, isSentenceAutoPlayingRef, stopAutoPlay, stopSlideshow, stopSentenceAutoPlay,
    autoPlaySpeed, autoPlaySpeedRef, cycleSpeed, autoPlayTimerMinutes, cycleTimerDuration, countdownStartedAt,
    sentenceGap, sentenceGapRef, cycleGap, sentenceRepeats, sentenceRepeatsRef, cycleRepeats, toggleAutoPlay,
    toggleSentenceAutoPlay,
  } = useAutoPlay();
  const speechStyle = useSpeechStyle();
  const { showSuccessAnim, rememberInfo, rememberingRef, showRemembered } = useRememberToast();

  // Keep a ref to savedItems so callbacks always see fresh data without re-creating
  const savedItemsRef = useLatest(savedItems);
  // Preview lookups run on every render, so index saved sentences once instead of re-normalizing all of them.
  const savedSentenceIndex = useSavedSentenceIndex(savedSentenceItems);

  const {
    exampleSentencePreview, savedPreviewSentence, previewSentence, openExampleSentencePreview, closeExampleSentencePreview,
  } = useExampleSentencePreview({
    onOpenExampleSentence, savedItemsRef, savedSentenceIndex, stopAutoPlay,
  });
  // An example opened over the card takes the keys and gestures.
  const detailInteractionLocked = interactionLocked || !!exampleSentencePreview;

  const data = currentItem.data;
  const type = currentItem.type;

  // The lock screen's next and previous read where the view is (see useAutoPlayReader).
  const currentGroupIndexRef = useLatest(currentGroupIndex);

  const title = type === 'phrase' ? (data as SearchResult).query : (data as VocabCard).word;

  // Saved comparisons that involve THIS word, surfaced as a "Comparisons" section below the card.
  const wordComparisons = comparisonsInvolving(comparisons, title);

  // Auto-pronounce the word when the card changes — but NOT during sentence auto-play, which
  // reads the example sentence instead (we don't want the word spoken over it).
  useEffect(() => {
    if (!title || isSentenceAutoPlaying) return;

    // Small delay to let animation settle before pronouncing
    const timer = setTimeout(() => {
      speakWord(title);
    }, 100);

    return () => clearTimeout(timer);
  }, [title, currentGroupIndex, currentItemIndex, isSentenceAutoPlaying]);

  // The cards the learner can move to next: this word's other meanings and the words either side. Their
  // pictures are decoded ahead, so each paints on its first frame.
  const upcomingItems = useMemo(() => {
    if (!groups?.length) return [];
    const index = Math.min(currentGroupIndex, groups.length - 1);
    return [groups[index], groups[index + 1], groups[index - 1]].flatMap(group => group?.items ?? []);
  }, [groups, currentGroupIndex]);
  useWarmImages(upcomingItems, onLazyLoadImage);

  // Warm the TTS cache for the example SENTENCES of this word and the words either side (the word itself
  // uses the system voice), so tapping one or auto-play right after moving a card plays at once, through
  // the iOS-unlocked <audio> element.
  useEffect(() => {
    const sentences = upcomingItems.flatMap(item => isVocabItem(item)
      ? item.data.examples ?? []
      : isPhraseItem(item) ? (item.data.vocabs ?? []).flatMap(vocab => vocab.examples ?? []) : []).filter(Boolean);
    if (sentences.length) prefetchTTS(sentences);
  }, [upcomingItems, speechStyle]);

  // Find saved item - first try by ID (most reliable), then fallback to title+sense matching
  const savedItemMatch = useMemo(() => findSavedCard(savedItems, data, title), [savedItems, data, title]);
  const isSaved = !!savedItemMatch;

  // Get mastery info for current item
  const mastery = savedItemMatch?.srs ? SRSAlgorithm.getMasteryLevel(savedItemMatch.srs) : null;
  const masteryColors = mastery ? getMasteryColors(mastery.color) : null;

  const {
    handleSaveVocab, handleToggleSave, handleSaveShortcut, handleDeleteItem, handleArchiveItem, handleUnarchiveItem,
    handleResetSRS, handleRemember,
  } = useWordActions({
    data, type, title, savedItemMatch, isSaved, savedItemsRef, isVocabSaved, onSave, onDelete, onArchive, onUnarchive,
    onResetSRS, onUpdateSRS, setShowActionMenu, rememberingRef, showRemembered,
  });

  // Navigation handlers for keyboard
  const handlePrevItem = useCallback(() => {
    if (hasPrevItem) {
      stopSlideshow();
      setCurrentItemIndex(prev => prev - 1);
    }
  }, [hasPrevItem, stopSlideshow, setCurrentItemIndex]);

  const handleNextItem = useCallback(() => {
    const totalItems = currentGroup ? currentGroup.items.length : 0;
    if (totalItems >= 1) {
      stopSlideshow();
      if (totalItems === 1) {
        // Single meaning: just pronounce
        if (currentItem) {
          const wordToSpeak = currentItem.type === 'phrase'
            ? (currentItem.data as SearchResult).query
            : (currentItem.data as VocabCard).word;
          if (wordToSpeak) speakWord(wordToSpeak);
        }
      } else {
        setCurrentItemIndex(prev => (prev + 1) % totalItems);
      }
    }
  }, [currentGroup, currentItem, stopSlideshow, setCurrentItemIndex]);

  const handlePrevGroup = useCallback(() => {
    if (hasPrevGroup && groups) {
      stopSlideshow();
      setCurrentGroupIndex(prev => prev - 1);
      setCurrentItemIndex(0);
    }
  }, [hasPrevGroup, groups, stopSlideshow, setCurrentGroupIndex, setCurrentItemIndex]);

  const handleNextGroup = useCallback(() => {
    if (hasNextGroup && groups) {
      stopSlideshow();
      setCurrentGroupIndex(prev => prev + 1);
      setCurrentItemIndex(0);
    }
  }, [hasNextGroup, groups, stopSlideshow, setCurrentGroupIndex, setCurrentItemIndex]);

  useWordSlideshow({
    isAutoPlaying, stopSlideshow, groups, currentGroupIndex, currentItemIndex, setCurrentGroupIndex,
    setCurrentItemIndex, autoPlaySpeedRef, title,
  });

  // The session to preload once sentence auto-play starts (see SessionPreload): every card's example
  // sentences, and the pictures the session shows.
  const getPreloadSession = (): PreloadSession => preloadSession(groups.flatMap(g => g.items), false);

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
    sentenceReview: false,
    readCard: () => ({ texts: autoPlayTexts(currentItem), title, artist: 'DictProp' }),
  });

  // Fresh ref to the on-screen card so the keyboard readers below read current data without re-subscribing.
  const currentItemRef = useLatest(currentItem);

  const { readCardExamples, toggleSpeak, speakSentenceAt } = useExampleSpeech({
    currentItemRef, isSentenceAutoPlayingRef, sentenceReview: false, stopAutoPlay,
  });

  // Stop any playback when the view closes (covers a manual read still going at close time).
  useEffect(() => () => { stopCurrent(); }, []);

  // Escape closes the action menu, then the view. A search sheet or dialog above the view takes Escape first;
  // an example preview on top is its own layer.
  useEscapeLayer(() => {
    if (showActionMenu) {
      setShowActionMenu(false);
      moreActionsRef.current?.querySelector('button')?.focus();
    } else {
      onClose();
    }
  }, 50, !detailInteractionLocked);

  // Keyboard navigation
  useKeyboardNavigation({
    onArrowLeft: handlePrevItem,
    onArrowRight: handleNextItem,
    onArrowUp: handlePrevGroup,
    onArrowDown: handleNextGroup,
    onSave: handleSaveShortcut,
    enabled: !showActionMenu && !detailInteractionLocked,
  });

  usePassKeysToFocusedControl(!showActionMenu && !detailInteractionLocked);

  // Trackpad wheel navigation
  useWheelNavigation({
    onScrollLeft: handlePrevItem,
    onScrollRight: handleNextItem,
    containerRef: scrollContainerRef,
    threshold: 80,
    enabled: !detailInteractionLocked,
  });

  const { zoneFlash, handleScroll, onContentTouchStart, onContentTouchEnd, handleDoubleClick } = useWordGestures({
    scrollContainerRef, showHeader, setShowHeader, currentGroup, currentItem, hasNextGroup, hasPrevGroup, hasPrevItem,
    setCurrentGroupIndex, setCurrentItemIndex, stopSlideshow, toggleSpeak, onClose, handleRemember,
  });

  useWordShortcuts({
    enabled: !showActionMenu && !detailInteractionLocked,
    rootRef,
    speakSentenceAt,
    setShowHeader,
    title,
    readCardExamples,
    handleRemember,
    handleResetSRS,
    handleToggleSave,
    handleDeleteItem,
    handleArchiveItem,
    isSaved,
    savedItemMatch,
    onUnarchive,
    isSentenceAutoPlaying,
    toggleSentenceAutoPlay,
    toggleAutoPlay,
    cycleSpeed,
  });

  // Eyes-free read-zone band counts, so the guides only draw the bands that read something.
  const wordZoneBands = countWordZoneBands(currentItem);
  // Show the guides wherever taps are possible (see PLATFORM.isTouchCapable).
  const touchCapable = PLATFORM.isTouchCapable;

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 bg-slate-50 flex flex-col shadow-2xl"
    >
      {/* Eyes-free read-zone guides (word/phrase view) — touch-only, since the screen-zone taps that
          drive them fire from a tap, not a mouse click. */}
      {touchCapable && wordZoneBands > 0 && (
        <EyesFreeZones anchor="viewport" bands={wordZoneBands} flash={zoneFlash} />
      )}
      {/* Word card. */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      {/* The header holds Close but stays hidden until asked for, so a close button is always on screen. */}
      {!showHeader && (
        <button
          type="button"
          onClick={onClose}
          className="absolute top-[calc(0.5rem+env(safe-area-inset-top))] right-3 z-40 w-11 h-11 rounded-full bg-white/80 text-slate-500 shadow-sm border border-slate-200/60 flex items-center justify-center hover:bg-white hover:text-slate-700 transition-colors"
          title="Close (Esc)"
          aria-label="Close"
        >
          <X size={20} />
        </button>
      )}
      <div
        ref={scrollContainerRef}
        data-word-card-scroll
        className="flex-1 min-h-0 overflow-y-auto no-scrollbar"
        style={{ touchAction: 'pan-y pinch-zoom' }}
        onScroll={handleScroll}
        onTouchStart={onContentTouchStart}
        onTouchEnd={onContentTouchEnd}
        onDoubleClick={handleDoubleClick}
      >
        {/* Minimal meaning indicator when header is hidden */}
        {!showHeader && currentGroup && currentGroup.items.length > 1 && (
          <MeaningDots count={currentGroup.items.length} index={currentItemIndex} />
        )}

        {/* Header - combined with progress bar. Opens to its own height when the learner asks for it and
            closes at once, so a card change never slides the next card up after it appears. */}
        <WordCardHeader
          showHeader={showHeader}
          onClose={onClose}
          itemCount={currentGroup.items.length}
          itemIndex={currentItemIndex}
          onRefresh={() => {
            // Use onRefresh if available (forces real AI search), otherwise fall back to onSearch
            if (onRefresh) {
              onRefresh(title);
            } else {
              onSearch(title);
            }
          }}
          isSaved={isSaved}
          onDelete={handleDeleteItem}
          onToggleSave={handleToggleSave}
          moreActionsRef={moreActionsRef}
          showActionMenu={showActionMenu}
          onToggleActionMenu={() => setShowActionMenu(!showActionMenu)}
          stats={isSaved && savedItemMatch && mastery && masteryColors ? { srs: savedItemMatch.srs, mastery, colors: masteryColors } : null}
          savedItems={savedItems}
        />

        <div className="p-4 pb-24 md:pb-8 md:px-6">

          {type === 'vocab' && (
            <ErrorBoundary variant="inline" fallbackMessage="This card couldn't be displayed.">
              <VocabCardDisplay
                data={data as VocabCard}
                showSave={false}
                onSearch={onSearch}
                scrollable={false}
                className="min-h-full shadow-none border-0 !p-0 bg-transparent !h-auto !overflow-visible max-w-3xl md:max-w-5xl lg:max-w-6xl xl:max-w-[1400px] 2xl:max-w-[1600px] mx-auto"
                showRefresh={false}
                onCompare={onCompare}
                onSaveSentence={onSaveSentence}
                onOpenExampleSentence={onOpenExampleSentence ? openExampleSentencePreview : undefined}
                isSentenceSaved={isSentenceSaved}
                onLazyLoadImage={onLazyLoadImage}
              />
            </ErrorBoundary>
          )}

          {/* Saved comparisons involving this word. */}
          {onOpenComparison && wordComparisons.length > 0 && (
            <WordComparisons comparisons={wordComparisons} onOpen={onOpenComparison} />
          )}

          {type === 'phrase' && (
            <PhraseBody
              phrase={data as SearchResult}
              onLazyLoadImage={onLazyLoadImage}
              onRemoveVocabFromPhrase={onRemoveVocabFromPhrase}
              onSaveVocab={handleSaveVocab}
              isVocabSaved={isVocabSaved}
              onSearch={onSearch}
              onCompare={onCompare}
              onSaveSentence={onSaveSentence}
              onOpenExampleSentence={onOpenExampleSentence ? openExampleSentencePreview : undefined}
              isSentenceSaved={isSentenceSaved}
            />
          )}

        </div>
      </div>
      </div>

      {/* Whole-session preload indicator (audio + images), bottom-left so it clears the autoplay cluster. */}
      <SessionPreload active={isSentenceAutoPlaying} getSession={getPreloadSession} onLazyLoadImage={onLazyLoadImage} />

      {/* Playback controls: the word slideshow and the examples' auto-play. */}
      <WordPlaybackControls
        countdownStartedAt={countdownStartedAt}
        timerMinutes={autoPlayTimerMinutes}
        onCycleTimer={cycleTimerDuration}
        slideshowPlaying={isAutoPlaying}
        slideSpeed={autoPlaySpeed}
        onCycleSpeed={cycleSpeed}
        onToggleSlideshow={toggleAutoPlay}
        examplesPlaying={isSentenceAutoPlaying}
        repeats={sentenceRepeats}
        onCycleRepeats={cycleRepeats}
        gap={sentenceGap}
        onCycleGap={cycleGap}
        onToggleExamples={toggleSentenceAutoPlay}
      />
      {/* Success Animation Overlay */}
      {showSuccessAnim && <RememberToast intervalDays={rememberInfo?.intervalDays ?? null} />}

      {/* Action menu dropdown - positioned fixed to escape overflow */}
      {showActionMenu && (
        <DetailActionMenu
          onUnarchive={savedItemMatch?.isArchived && onUnarchive ? handleUnarchiveItem : undefined}
          onArchive={onArchive ? handleArchiveItem : undefined}
          onResetMemory={handleResetSRS}
          onDelete={handleDeleteItem}
          onClose={() => setShowActionMenu(false)}
        />
      )}

      {exampleSentencePreview && previewSentence && (
        <ExampleSentencePreview
          viewProps={props}
          sourceGroup={exampleSentencePreview.sourceGroup}
          sentence={previewSentence}
          saved={!!savedPreviewSentence}
          onClose={closeExampleSentencePreview}
        />
      )}

    </div>
  );
}
