import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { VocabCard, SearchResult, StoredItem, SentenceData, getItemTitle, getItemSpelling, getItemSense, getItemImageUrl, ItemGroup, isPhraseItem, isVocabItem, StoredComparison, type ReviewRating, type SRSData } from '../types';
import { ArrowLeft, Bookmark, BookmarkMinus, Search as SearchIcon, RefreshCw, Trash2, MoreVertical, RotateCcw, Flame, CheckCircle2, X, Play, Pause, AudioLines, Volume2, ExternalLink, MessageSquareQuote, Loader2, Scale, ImagePlus, Image as ImageIcon, Copy, Check, ClipboardPaste, BookOpenText, Lock } from 'lucide-react';
import { Button } from '../components/Button';
import { VocabCardDisplay, buildChatGPTUrl } from '../components/VocabCard';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { OfflineImage } from '../components/OfflineImage';
import { SpeechStyleToggle } from '../components/SpeechStyleToggle';
import { PlaybackSpeedToggle } from '../components/PlaybackSpeedToggle';
import { HighlightedSentence, stripSentenceMarkers } from '../components/HighlightedSentence';
import { SentenceSpeakerButton } from '../components/SentenceSpeakerButton';
import { SentenceAnalysisView } from '../components/SentenceAnalysisView';
import { EyesFreeZones, type ZoneFlash } from '../components/EyesFreeZones';
import { AutoPlayCountdown } from '../components/AutoPlayCountdown';
import { SessionPreload, type PreloadSession } from '../components/SessionPreload';
import { getMasteryColors } from '../components/mastery';
import { useEscapeLayer } from '../components/escapeStack';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { updateAfterRating } from '../services/fsrsScheduler';
import { useKeyboardNavigation, useWheelNavigation, useWarmImages } from '../hooks';
import { speakNatural, speakWord, prefetchTTS, preloadAudio, getPlaybackState, getPlaybackProgress, pauseCurrent, resumeCurrent, stopCurrent, seekCurrent, getTimingsFor, ensureTimings, setMediaMetadata, setMediaSessionHandlers, primeKeepAlive, acquireKeepAlive, releaseKeepAlive, afterGap, type SpeakHandle } from '../services/lazyTts';
import { alignWordsToStripped, seekTimeForOffset } from '../services/ttsAlignment';
import { getTtsStyle, setTtsStyle, subscribeTtsStyle, type TtsStyle } from '../services/ttsSettings';
import { log, warn, error as logError } from '../services/logger';
import { isRealLifeProgressItem } from '../services/realLifeProgress';
import { normalizeSentenceIdentity } from '../services/sentenceIdentity';
import { copyTextToClipboard, extractImageFromTransfer, fileToDataUri, formatRelativeTime, hasDetailedSentenceAnalysis, mergePreparedSentence, readImageFromSystemClipboard, SENTENCE_PREFETCH_AHEAD, serverImageVersion } from './detail/detailUtils';
import { GrammarNotes } from './detail/GrammarNotes';
import { LibraryCounts } from './detail/LibraryCounts';
import { PhraseVocabCard } from './detail/PhraseVocabCard';
import { RememberToast } from './detail/RememberToast';
import { DetailActionMenu } from './detail/DetailActionMenu';
import { isDialogOpenOutside, isImeKey, isKeyboardFocusedControl, isTypingTarget } from './keyboardTarget';

interface DetailViewProps {
  groups?: ItemGroup[];
  initialGroupIndex?: number;
  initialItemIndex?: number;
  
  onClose: () => void;
  onSave: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
  /** Returns an archived card to review; the action menu and the A key offer it on archived cards. */
  onUnarchive?: (id: string) => void;
  /** Resets a saved item's progress, with an offer to undo. False when the item isn't in the library. */
  onResetSRS?: (id: string) => boolean;
  savedItems: StoredItem[];
  /** Sentence records are separate from notebook cards; used to resolve catalog progress by exact id. */
  savedSentenceItems?: StoredItem[];
  onSearch: (text: string) => void;
  onRefresh?: (text: string) => void; // Force a real AI search, bypassing local cache
  onLazyLoadImage?: (itemId: string, imageVersion?: string) => Promise<string | null>; // Fetch image from server if missing locally
  onUpdateSRS?: (
    itemId: string,
    rating?: ReviewRating,
    context?: { seedItem?: StoredItem },
  ) => void | Promise<boolean>; // Direct SRS update (triggers "remember")
  onCompare?: (words: string[]) => void;
  comparisons?: StoredComparison[];          // saved comparisons (surfaced when they involve this word)
  comparingKeys?: string[];                   // comparison keys currently generating (background queue)
  onOpenComparison?: (words: string[]) => void;
  onSaveSentence?: (text: string, word: string, sense?: string, prepared?: SentenceData) => void;
  onOpenExampleSentence?: (text: string, word: string, sense?: string) => StoredItem | null | Promise<StoredItem | null>;
  isSentenceSaved?: (text: string) => boolean;
  /** Whether a word and sense is in the notebook, looked up in a prebuilt set. */
  isVocabSaved: (vocab: VocabCard) => boolean;
  onRemoveVocabFromPhrase?: (phraseId: string, vocabId: string) => void;
  /** When provided, DetailView enters "sentence mode": aligned 1:1 with `groups`, sentenceItems[i] is
   *  the saved sentence whose source card is groups[i]. Drives the banner, SRS, TTS, autoplay & delete. */
  sentenceItems?: StoredItem[];
  /** Footnote support in the sentence hero: look up a saved item for a term, and open its full card. */
  findSaved?: (term: string) => StoredItem | null;
  onOpenCard?: (item: StoredItem) => void;
  /** True while the card popup owns input — DetailView's keyboard/nav handlers stand down. */
  interactionLocked?: boolean;
  /** Read-only example preview. Analysis/audio remain available; review mutations require saving first. */
  sentencePreviewOnly?: boolean;
  /** Sentence mode: attach a pasted/picked image to a sentence (offloads to IDB + server, marks the item). */
  onAttachImage?: (item: StoredItem, base64: string) => Promise<void> | void;
}

/** With no card to show (no groups, or an empty group) the view renders nothing. That's decided out here
 *  rather than partway through the body, whose hooks must run in the same order on every render. */
export const DetailView: React.FC<DetailViewProps> = (props) => {
  const { groups } = props;
  if (!groups?.length || groups.some(group => group.items.length === 0)) return null;
  return <DetailViewBody {...props} groups={groups} />;
};

const DetailViewBody: React.FC<DetailViewProps & { groups: ItemGroup[] }> = ({
  groups,
  initialGroupIndex = 0,
  initialItemIndex = 0,
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
  comparingKeys,
  onOpenComparison,
  onSaveSentence,
  onOpenExampleSentence,
  isSentenceSaved,
  isVocabSaved,
  onRemoveVocabFromPhrase,
  sentenceItems,
  findSaved,
  onOpenCard,
  interactionLocked = false,
  sentencePreviewOnly = false,
  onAttachImage,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(navigator.userAgent);
  const isMobile = isIOS || isAndroid;
  // iPadOS commonly reports MacIntel, so exclude touch devices before enabling laptop-only Command
  // interactions. Checking both fields covers current Chromium/Safari and older Firefox builds.
  const isMacDesktop = !isMobile && /Mac/i.test(`${navigator.platform} ${navigator.userAgent}`);

  // State for 2D navigation
  const [currentGroupIndex, setCurrentGroupIndex] = useState(initialGroupIndex);
  const [currentItemIndex, setCurrentItemIndex] = useState(initialItemIndex);
  
  const [showHeader, setShowHeader] = useState(false); // Hidden by default, shown on short swipe down or H key
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [sentencePage, setSentencePage] = useState<'sentence' | 'analysis'>('sentence');
  const [exampleSentencePreview, setExampleSentencePreview] = useState<{
    sentence: StoredItem;
    sourceGroup: ItemGroup;
  } | null>(null);
  const exampleSentenceRequestRef = useRef(0);
  const detailInteractionLocked = interactionLocked || !!exampleSentencePreview;
  const rootRef = useRef<HTMLDivElement>(null);
  const moreActionsRef = useRef<HTMLDivElement>(null);
  // Sentence review — what tapping a word does. true (default) = play from that word (current behaviour);
  // false = look up the dotted [[uncommon]] term via the bottom-right search, like every other view. Persisted.
  const [tapToPlay, setTapToPlay] = useState(() => {
    try { return localStorage.getItem('dictprop_sentence_tap_play') !== '0'; } catch { return true; }
  });
  const [isCommandHeld, setIsCommandHeld] = useState(false);
  useEffect(() => {
    if (!isMacDesktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta') setIsCommandHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta') setIsCommandHeld(false);
    };
    const reset = () => setIsCommandHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
    };
  }, [isMacDesktop]);
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [autoPlaySpeed, setAutoPlaySpeed] = useState(2000); // ms
  const [autoPlayTimerMinutes, setAutoPlayTimerMinutes] = useState(20);
  const [autoPlayStartedAt, setAutoPlayStartedAt] = useState<number | null>(null);
  const [isSentenceAutoPlaying, setIsSentenceAutoPlaying] = useState(false);
  const isSentenceAutoPlayingRef = useRef(isSentenceAutoPlaying);
  useEffect(() => { isSentenceAutoPlayingRef.current = isSentenceAutoPlaying; }, [isSentenceAutoPlaying]);
  const [showSentenceAutoPlayPanel, setShowSentenceAutoPlayPanel] = useState(false);
  const [sentenceGap, setSentenceGap] = useState(2000); // ms of silence between every read (repeats + distinct sentences)
  const [sentenceRepeats, setSentenceRepeats] = useState(3); // times each sentence is read (total), 1–5
  const [prefetchSpeechStyle, setPrefetchSpeechStyle] = useState(getTtsStyle);
  useEffect(() => subscribeTtsStyle(setPrefetchSpeechStyle), []);
  const [showSuccessAnim, setShowSuccessAnim] = useState(false);
  const [rememberInfo, setRememberInfo] = useState<{ intervalDays: number } | null>(null);
  const successAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (successAnimTimerRef.current) clearTimeout(successAnimTimerRef.current); }, []);
  const lastScrollY = useRef(0);

  // Keep a ref to savedItems so callbacks always see fresh data without re-creating
  const savedItemsRef = useRef(savedItems);
  useEffect(() => { savedItemsRef.current = savedItems; }, [savedItems]);
  const savedSentenceItemsRef = useRef(savedSentenceItems);
  useEffect(() => { savedSentenceItemsRef.current = savedSentenceItems; }, [savedSentenceItems]);
  // Preview lookups run on every render, so index saved sentences once instead of re-normalizing all of them.
  const savedSentenceIndex = useMemo(() => {
    const byId = new Map<string, StoredItem>();
    const byIdentity = new Map<string, StoredItem[]>();
    for (const item of savedSentenceItems) {
      if (item.type !== 'sentence' || item.isDeleted) continue;
      byId.set(item.data.id, item);
      const identity = normalizeSentenceIdentity((item.data as SentenceData).text);
      if (!identity) continue;
      const matches = byIdentity.get(identity);
      if (matches) matches.push(item);
      else byIdentity.set(identity, [item]);
    }
    return { byId, byIdentity };
  }, [savedSentenceItems]);
  const onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  // Determine current item to display. The indices start from the caller's and can outrun groups that a
  // delete or archive shrank, so what's shown is clamped here and the indices themselves just below.
  const safeGroupIndex = Math.max(0, Math.min(currentGroupIndex, groups.length - 1));
  const currentGroup = groups[safeGroupIndex];
  const safeItemIndex = Math.max(0, Math.min(currentItemIndex, currentGroup.items.length - 1));
  const currentItem = currentGroup.items[safeItemIndex];
  const hasNextGroup = safeGroupIndex < groups.length - 1;
  const hasPrevGroup = safeGroupIndex > 0;
  const hasPrevItem = safeItemIndex > 0;

  // The dots, the "i / N" counter and stepping back read the indices, so bring them back in range too.
  useLayoutEffect(() => {
    if (currentGroupIndex !== safeGroupIndex) setCurrentGroupIndex(safeGroupIndex);
    if (currentItemIndex !== safeItemIndex) setCurrentItemIndex(safeItemIndex);
  }, [currentGroupIndex, safeGroupIndex, currentItemIndex, safeItemIndex]);

  // Reset item index and scroll when user navigates to a different group (not on groups rebuild). Every
  // way of moving between words lands here, and the layout effect paints the new one from its top. The
  // resets are skipped when already in place: setting a state to its current value right after a render
  // still runs this whole component again.
  const prevGroupIndexRef = useRef(currentGroupIndex);
  useLayoutEffect(() => {
    if (prevGroupIndexRef.current !== currentGroupIndex) {
      prevGroupIndexRef.current = currentGroupIndex;
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      // Keep the analysis page open while moving between saved sentences. Word review still resets to
      // its primary page when changing groups.
      if (sentenceItems?.length) {
        const analysisScroller = document.querySelector<HTMLElement>('[data-sentence-analysis]');
        if (analysisScroller) analysisScroller.scrollTop = 0;
      } else if (sentencePage !== 'sentence') {
        setSentencePage('sentence');
      }
      if (currentItemIndex !== 0) setCurrentItemIndex(0);
    }
  }, [currentGroupIndex, sentenceItems, sentencePage, currentItemIndex]);

  // These handlers go to the memoized word cards, so they keep one identity across renders and a card
  // renders again only when something it shows changes.
  const openExampleSentencePreview = useCallback((text: string, word: string, sense?: string) => {
    if (!onOpenExampleSentence) return;
    const requestId = ++exampleSentenceRequestRef.current;
    const previewId = `sentence-preview:${crypto.randomUUID()}`;
    const sentence: StoredItem = {
      data: { id: previewId, text, sourceWord: word, sourceSense: sense },
      type: 'sentence',
      savedAt: Date.now(),
      srs: SRSAlgorithm.createNew(previewId, 'sentence'),
    };
    const spelling = word.toLowerCase().trim();
    const candidates = savedItemsRef.current.filter(item =>
      item.type === 'vocab' && getItemSpelling(item) === spelling
    );
    let source = (sense ? candidates.find(item => getItemSense(item) === sense) : undefined) || candidates[0];
    if (!source) {
      const synthetic: VocabCard = {
        id: `sentence-src:${sentence.data.id}`,
        word: word || '(unknown word)',
        sense,
        chinese: '',
        ipa: '',
        definition: '',
        forms: [],
        wordFamily: [],
        synonyms: [],
        antonyms: [],
        confusables: [],
        examples: [text],
        history: '',
        register: '',
        mnemonic: '',
      };
      source = {
        data: synthetic,
        type: 'vocab',
        savedAt: Date.now(),
        srs: SRSAlgorithm.createNew(synthetic.id, 'vocab'),
      };
    }
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    stopCurrent();
    setExampleSentencePreview({
      sentence,
      sourceGroup: { title: getItemTitle(source), items: [source] },
    });
    void Promise.resolve(onOpenExampleSentence(text, word, sense)).then(hydrated => {
      if (!hydrated || exampleSentenceRequestRef.current !== requestId) return;
      setExampleSentencePreview(current => current ? { ...current, sentence: hydrated } : current);
    }).catch(error => {
      logError('Failed to open prepared example sentence:', error);
    });
  }, [onOpenExampleSentence]);

  const handleSaveVocab = useCallback((vocab: VocabCard) => {
    const vocabSpelling = (vocab.word || '').toLowerCase().trim();
    const items = savedItemsRef.current;
    const isAlreadySaved = items.some(i =>
      getItemSpelling(i) === vocabSpelling && getItemSense(i) === vocab.sense
    );

    if (isAlreadySaved) {
      const existingItem = items.find(i =>
        getItemSpelling(i) === vocabSpelling && getItemSense(i) === vocab.sense
      );
      if (existingItem) {
        onDelete(existingItem.data.id);
      }
    } else {
      onSave({
        data: vocab,
        type: 'vocab',
        savedAt: Date.now(),
        srs: SRSAlgorithm.createNew(vocab.id, 'vocab')
      });
    }
  }, [onDelete, onSave]);

  const data = currentItem.data;
  const type = currentItem.type;

  const savedPreviewSentence = exampleSentencePreview
    ? [savedSentenceIndex.byId.get(exampleSentencePreview.sentence.data.id)]
        .concat(savedSentenceIndex.byIdentity.get(
          normalizeSentenceIdentity((exampleSentencePreview.sentence.data as SentenceData).text),
        ) ?? [])
        .find(item => !!item && !isRealLifeProgressItem(item))
    : undefined;
  const previewSentence = exampleSentencePreview
    ? savedPreviewSentence
      ? {
          ...savedPreviewSentence,
          data: {
            ...(exampleSentencePreview.sentence.data as SentenceData),
            ...(savedPreviewSentence.data as SentenceData),
            analysis: (savedPreviewSentence.data as SentenceData).analysis ??
              (exampleSentencePreview.sentence.data as SentenceData).analysis,
            imageUrl: (savedPreviewSentence.data as SentenceData).imageUrl ??
              (exampleSentencePreview.sentence.data as SentenceData).imageUrl,
          },
        }
      : exampleSentencePreview.sentence
    : null;

  // ── Sentence mode ────────────────────────────────────────────────────────────
  // Opened from the Sentences tab: each group is one saved sentence's source card, and
  // sentenceItems[currentGroupIndex] is the sentence being reviewed. Drives the banner,
  // SRS/TTS/delete targeting, and the natural-voice sentence autoplay.
  const sentenceMode = !!(sentenceItems && sentenceItems.length > 0);
  // Clamp to the (possibly shrunk-by-deletion) list so the shown card AND the "i / N" counter stay valid
  // even when the local index is briefly stale relative to the latest sentenceItems.
  const sentenceIndex = sentenceMode ? Math.min(currentGroupIndex, sentenceItems!.length - 1) : 0;
  const currentSentenceSnapshot = sentenceMode ? (sentenceItems![sentenceIndex] ?? null) : null;
  const catalogSentencePreview = !!(currentSentenceSnapshot &&
    (currentSentenceSnapshot.data as SentenceData).catalogSentenceId);
  const catalogPreviewKind = currentSentenceSnapshot
    ? ((currentSentenceSnapshot.data as SentenceData).catalogKind ?? 'real-life')
    : undefined;
  const [preparedSentenceById, setPreparedSentenceById] = useState<Record<string, StoredItem>>({});
  const [preparingSentenceId, setPreparingSentenceId] = useState<string | null>(null);
  const preparationRequestsRef = useRef(new Set<string>());
  const checkedSentenceEnrichmentsRef = useRef(new Set<string>());
  const preparedSentenceSnapshot = currentSentenceSnapshot
    ? mergePreparedSentence(
        currentSentenceSnapshot,
        preparedSentenceById[currentSentenceSnapshot.data.id],
      )
    : null;
  const currentSentenceData = currentSentenceSnapshot?.data as SentenceData | undefined;
  const savedCurrentSentence = currentSentenceSnapshot
    ? catalogSentencePreview
      ? savedSentenceItems.find(item => item.type === 'sentence' && !item.isDeleted && (
          item.data.id === currentSentenceSnapshot.data.id ||
          ((item.data as SentenceData).catalogSentenceId === currentSentenceData?.catalogSentenceId &&
            (item.data as SentenceData).catalogCollectionId === currentSentenceData?.catalogCollectionId)
        ))
      : currentSentenceSnapshot.data.id.startsWith('sentence-preview:')
        ? savedSentenceIndex.byIdentity.get(normalizeSentenceIdentity(currentSentenceData?.text ?? ''))?.[0]
        : undefined
    : undefined;
  const readOnlySentencePreview = sentencePreviewOnly || (catalogSentencePreview && !savedCurrentSentence);
  const currentSentence = savedCurrentSentence && preparedSentenceSnapshot
    ? mergePreparedSentence(savedCurrentSentence, preparedSentenceSnapshot)
    : preparedSentenceSnapshot;
  const isSentencePreview = !savedCurrentSentence && !!currentSentenceSnapshot &&
    (readOnlySentencePreview || currentSentenceSnapshot.data.id.startsWith('sentence-preview:'));
  const currentSentenceText = currentSentence ? (currentSentence.data as SentenceData).text : '';
  const sentenceExitLabel = catalogSentencePreview
    ? catalogPreviewKind === 'essay' ? 'Essays' : 'Real Life'
    : isSentencePreview
      ? 'Word'
      : 'Sentences';

  // Current sentence plus the five immediately ahead. The item JSON is already resident, but catalog
  // enrichment is fetched separately, so warm it before those sentences become visible. This also
  // upgrades saved legacy analyses whenever the shared enrichment pool has a detailed replacement.
  const sentencePreloadWindow = useMemo(() => {
    if (!sentenceMode || !sentenceItems?.length) return [];
    return sentenceItems
      .slice(sentenceIndex, sentenceIndex + SENTENCE_PREFETCH_AHEAD + 1)
      .map(sentence => mergePreparedSentence(sentence, preparedSentenceById[sentence.data.id]));
  }, [sentenceMode, sentenceItems, sentenceIndex, preparedSentenceById]);

  const prepareSentenceEnrichment = useCallback(async (snapshot: StoredItem, showLoading: boolean) => {
    const id = snapshot.data.id;
    const sourceSentence = snapshot.data as SentenceData;
    const requestKey = `${id}:${normalizeSentenceIdentity(sourceSentence.text)}`;
    if ((hasDetailedSentenceAnalysis(sourceSentence.analysis) && sourceSentence.imageUrl) ||
        checkedSentenceEnrichmentsRef.current.has(requestKey) ||
        preparationRequestsRef.current.has(requestKey)) return;

    preparationRequestsRef.current.add(requestKey);
    if (showLoading && !hasDetailedSentenceAnalysis(sourceSentence.analysis)) setPreparingSentenceId(id);
    try {
      const { default: loadPreparedSentenceEnrichment } = await import('../services/sentenceEnrichment');
      const result = await loadPreparedSentenceEnrichment(sourceSentence.text);
      checkedSentenceEnrichmentsRef.current.add(requestKey);
      if (!result) return;

      const preparedItem: StoredItem = {
        ...snapshot,
        data: {
          ...sourceSentence,
          analysis: result.analysis,
          analysisGeneratedAt: result.analysisGeneratedAt,
          imageUrl: sourceSentence.imageUrl ?? result.imageUrl,
        },
      };
      setPreparedSentenceById(current => ({
        ...current,
        [id]: mergePreparedSentence(current[id] ?? snapshot, preparedItem),
      }));

      // A lookup is read-only for catalog previews, but an already-saved sentence should retain the
      // richer result and its image link across devices. Read the ref after the await to preserve any
      // SRS update that happened while this request was in flight.
      const savedMatch = savedSentenceItemsRef.current.find(candidate => {
        if (candidate.type !== 'sentence' || candidate.isDeleted) return false;
        const candidateData = candidate.data as SentenceData;
        return candidate.data.id === id ||
          (!!sourceSentence.catalogSentenceId &&
            candidateData.catalogSentenceId === sourceSentence.catalogSentenceId &&
            candidateData.catalogCollectionId === sourceSentence.catalogCollectionId) ||
          normalizeSentenceIdentity(candidateData.text) === normalizeSentenceIdentity(sourceSentence.text);
      });
      if (!savedMatch) return;

      const savedData = savedMatch.data as SentenceData;
      const replaceAnalysis = !hasDetailedSentenceAnalysis(savedData.analysis);
      const nextImageUrl = savedData.imageUrl ?? result.imageUrl;
      if (!replaceAnalysis && nextImageUrl === savedData.imageUrl) return;
      onSaveRef.current({
        ...savedMatch,
        data: {
          ...savedData,
          ...(sourceSentence.catalogSentenceId ? { catalogSentenceId: sourceSentence.catalogSentenceId } : {}),
          ...(sourceSentence.catalogCollectionId ? { catalogCollectionId: sourceSentence.catalogCollectionId } : {}),
          ...(sourceSentence.catalogKind ? { catalogKind: sourceSentence.catalogKind } : {}),
          ...(sourceSentence.catalogTitle ? { catalogTitle: sourceSentence.catalogTitle } : {}),
          analysis: replaceAnalysis ? result.analysis : savedData.analysis,
          analysisGeneratedAt: replaceAnalysis ? result.analysisGeneratedAt : savedData.analysisGeneratedAt,
          ...(nextImageUrl ? { imageUrl: nextImageUrl } : {}),
        },
      });
    } catch (error) {
      // Network failures are deliberately not marked checked: moving forward or reconnecting retries.
      warn('Failed to preload sentence enrichment', error);
    } finally {
      preparationRequestsRef.current.delete(requestKey);
      if (showLoading) setPreparingSentenceId(current => current === id ? null : current);
    }
  }, []);

  useEffect(() => {
    const prepare = () => {
      for (let index = 0; index < sentencePreloadWindow.length; index++) {
        void prepareSentenceEnrichment(sentencePreloadWindow[index], index === 0);
      }
    };
    prepare();
    window.addEventListener('online', prepare);
    return () => window.removeEventListener('online', prepare);
  }, [sentencePreloadWindow, prepareSentenceEnrichment]);

  // User-attached image for the sentence under review. Base64 → render directly; a marker
  // ('idb:stored'/'server:has_image') → OfflineImage lazy-loads it by id (IDB, then server).
  const sentenceImageUrl = currentSentence ? getItemImageUrl(currentSentence) : undefined;
  const hasSentenceImage = !!sentenceImageUrl;
  const sentenceImageDirectSrc = sentenceImageUrl;

  // Refs so the post-remember timer and key handlers read fresh sentence state without re-subscribing.
  const sentenceModeRef = useRef(sentenceMode);
  const currentSentenceRef = useRef(currentSentence);
  const sentenceItemsRef = useRef(sentenceItems);
  const currentGroupIndexRef = useRef(currentGroupIndex);
  useEffect(() => {
    sentenceModeRef.current = sentenceMode;
    currentSentenceRef.current = currentSentence;
    sentenceItemsRef.current = sentenceItems;
    currentGroupIndexRef.current = currentGroupIndex;
  });

  const currentSentenceSpeechStyle = currentSentence
    ? (currentSentence.data as SentenceData).preferredSpeechStyle
    : undefined;

  // Each saved sentence remembers its own last choice. Sentences without one continue using the
  // persisted global fallback, so existing libraries retain their current behaviour until selected.
  useEffect(() => {
    if (sentenceMode && currentSentenceSpeechStyle) setTtsStyle(currentSentenceSpeechStyle);
  }, [sentenceMode, currentSentence?.data.id, currentSentenceSpeechStyle]);

  const rememberCurrentSentenceSpeechStyle = useCallback((nextStyle: TtsStyle) => {
    const sentence = currentSentenceRef.current;
    if (!sentence || isSentencePreview) return;
    const sentenceData = sentence.data as SentenceData;
    if (sentenceData.preferredSpeechStyle === nextStyle) return;
    const updated: StoredItem = {
      ...sentence,
      data: { ...sentenceData, preferredSpeechStyle: nextStyle },
      updatedAt: Date.now(),
    };
    currentSentenceRef.current = updated;
    onSaveRef.current(updated);
  }, [isSentencePreview]);

  // Sentence-mode stats (mirror the word-card stats below, computed across the saved sentences).
  const sentenceMastery = !isSentencePreview && currentSentence?.srs
    ? SRSAlgorithm.getMasteryLevel(currentSentence.srs)
    : null;
  const sentenceMasteryColors = sentenceMastery ? getMasteryColors(sentenceMastery.color) : null;
  const { sentenceMemorizedCount, sentenceDueCount } = useMemo(() => {
    const list = sentenceItems ?? [];
    const now = Date.now();
    return {
      sentenceMemorizedCount: list.filter(s => (s.srs?.memoryStrength ?? 0) >= 70).length,
      sentenceDueCount: list.filter(s => (s.srs?.nextReview ?? 0) <= now).length,
    };
  }, [sentenceItems]);

  // ── Sentence image attach (paste / drop / pick) ──────────────────────────────
  const [showImagePanel, setShowImagePanel] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageDragOver, setImageDragOver] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
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
  }, [onAttachImage]);

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

  // ⌘V / Ctrl+V anywhere in sentence mode attaches a pasted image to the current sentence. Uses the
  // `paste` event (which carries clipboardData). Stands down when a text field is focused, when another
  // overlay owns input, or when the paste has no image (so normal text paste still works everywhere).
  useEffect(() => {
    if (!onAttachImage) return;
    const onPaste = (e: ClipboardEvent) => {
      if (!sentenceModeRef.current || detailInteractionLocked || showActionMenu) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      const file = extractImageFromTransfer(e.clipboardData);
      if (!file) return;                              // no image → let the paste proceed normally
      e.preventDefault();
      setShowImagePanel(true);                        // surface the panel so the upload spinner is visible
      void attachImageFromFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onAttachImage, detailInteractionLocked, showActionMenu, attachImageFromFile]);

  // Focus the panel card when it opens so an in-panel ⌘V lands on its onPaste handler.
  useEffect(() => {
    if (!showImagePanel || imageUploading) return;
    (document.querySelector('[data-image-panel]') as HTMLElement | null)?.focus();
  }, [showImagePanel, imageUploading]);

  // ── Copy the sentence to the clipboard (to paste into Meta AI or anywhere). ──────
  const [sentenceCopy, setSentenceCopy] = useState<'copied' | 'failed' | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);
  const handleCopySentence = useCallback(async () => {
    const s = currentSentenceRef.current;                 // read via ref → never a stale sentence
    const text = s ? stripSentenceMarkers((s.data as SentenceData).text || '').trim() : '';
    if (!text) return;
    const copied = await copyTextToClipboard(text);
    setSentenceCopy(copied ? 'copied' : 'failed');         // flip icon → green check, or a red cross if it failed
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setSentenceCopy(null), 1600);
  }, []);

  // Small copy button that sits beside the sentence's speaker button (same compact icon style). Rendered
  // in exactly one hero branch at a time (the image / no-image ternary), so reusing the element is safe.
  const copySentenceButton = (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void handleCopySentence(); }}
      className={`p-2.5 -m-2 transition-colors ${sentenceCopy === 'copied' ? 'text-emerald-500' : sentenceCopy === 'failed' ? 'text-rose-500' : 'text-indigo-300 hover:text-indigo-600'}`}
      title={sentenceCopy === 'copied' ? 'Copied — paste it into Meta AI' : sentenceCopy === 'failed' ? "Couldn't copy — select the sentence and copy it instead" : 'Copy sentence (to paste into Meta AI)'}
    >
      {sentenceCopy === 'copied' ? <Check size={14} /> : sentenceCopy === 'failed' ? <X size={14} /> : <Copy size={14} />}
    </button>
  );
  const commandClickHint = isMacDesktop ? (
    <span
      className={`hidden h-6 w-6 items-center justify-center rounded-full text-xs font-semibold transition-colors sm:inline-flex ${isCommandHeld ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}`}
      title="Command-click a word to start playback there"
      aria-label="Command-click a word to start playback there"
      onClick={(e) => e.stopPropagation()}
    >
      <kbd className="font-sans">⌘</kbd>
    </span>
  ) : null;

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const currentScrollY = target.scrollTop;

    // Header auto-hide logic: hide when scrolling down, but only show via gesture or keyboard
    if (showHeader && currentScrollY > lastScrollY.current && currentScrollY > 50) {
      setShowHeader(false);
    }
    
    lastScrollY.current = currentScrollY;
  };
  
  // Touch Handling for swipe navigation
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  // A two-finger word chord owns both touch endings; blank-space sentence gestures must ignore them.
  const mobileWordChordActiveRef = useRef(false);
  const suppressMobileWordClickUntilRef = useRef(0);
  useEffect(() => {
    const finishMobileWordChord = (e: TouchEvent) => {
      if (!mobileWordChordActiveRef.current || e.touches.length > 0) return;
      mobileWordChordActiveRef.current = false;
      suppressMobileWordClickUntilRef.current = Date.now() + 500;
    };
    window.addEventListener('touchend', finishMobileWordChord, { passive: true });
    window.addEventListener('touchcancel', finishMobileWordChord, { passive: true });
    return () => {
      window.removeEventListener('touchend', finishMobileWordChord);
      window.removeEventListener('touchcancel', finishMobileWordChord);
    };
  }, []);
  // Sentence-mode eyes-free taps: last tap (time + position) so a quick second tap reads as a double-tap.
  const lastSentenceTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const sentenceSingleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressSentenceSurfaceClickUntilRef = useRef(0);
  // Guard so a remember can't fire twice from one gesture (touch double-tap + a synthesized dblclick).
  const rememberingRef = useRef(false);
  const cancelPendingSentenceSingleTap = () => {
    if (sentenceSingleTapTimerRef.current) clearTimeout(sentenceSingleTapTimerRef.current);
    sentenceSingleTapTimerRef.current = null;
    lastSentenceTapRef.current = null;
  };
  const queueSentenceSurfaceTap = (x: number, y: number) => {
    const now = Date.now();
    const previous = lastSentenceTapRef.current;
    const isDoubleTap = !!previous && now - previous.t < 320 &&
      Math.abs(x - previous.x) < 40 && Math.abs(y - previous.y) < 40;
    if (isDoubleTap) {
      cancelPendingSentenceSingleTap();
      handleRemember();
      return;
    }

    // Preserve an unrelated first tap before beginning a new double-tap window.
    if (sentenceSingleTapTimerRef.current) {
      clearTimeout(sentenceSingleTapTimerRef.current);
      sentenceSingleTapTimerRef.current = null;
      toggleSentencePlayback();
    }
    lastSentenceTapRef.current = { t: now, x, y };
    sentenceSingleTapTimerRef.current = setTimeout(() => {
      sentenceSingleTapTimerRef.current = null;
      lastSentenceTapRef.current = null;
      toggleSentencePlayback();
    }, 320);
  };
  useEffect(() => () => cancelPendingSentenceSingleTap(), []);
  // Eyes-free zone tap-confirmation flash (see EyesFreeZones). The word/phrase-view guides only render
  // on touch devices, since those zones only fire from taps (a mouse click does nothing there).
  const [zoneFlash, setZoneFlash] = useState<ZoneFlash | null>(null);
  const zoneFlashN = useRef(0);
  const zoneFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashZone = useCallback((zone: number) => {
    zoneFlashN.current += 1;
    setZoneFlash({ zone, n: zoneFlashN.current });
    if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current);
    zoneFlashTimer.current = setTimeout(() => setZoneFlash(null), 500);
  }, []);
  useEffect(() => () => { if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current); }, []);
  // Show the word/phrase-view guides wherever taps are possible. The zones fire from touchend, so gate
  // on touch CAPABILITY (maxTouchPoints) — NOT a pointer media query: iPadOS Safari defaults to
  // "desktop-class" browsing and then reports (any-pointer: coarse) as false even though touch works,
  // which would hide the guides on the exact device they're meant for. matchMedia is an OR fallback.
  const touchCapable = useMemo(
    () =>
      typeof navigator !== 'undefined' &&
      ((navigator.maxTouchPoints ?? 0) > 0 ||
        (typeof window !== 'undefined' && !!window.matchMedia?.('(any-pointer: coarse)')?.matches)),
    [],
  );

  const onContentTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
  };
  
  const onContentTouchEnd = (e: React.TouchEvent) => {
    if (mobileWordChordActiveRef.current) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    if (touchStartX.current === null || touchStartY.current === null) return;
    
    // Check if user is selecting text - don't interfere with text selection on iOS
    const selection = window.getSelection();
    const hasTextSelection = selection && selection.toString().trim().length > 0;
    if (hasTextSelection) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    
    const diffX = e.changedTouches[0].clientX - touchStartX.current;
    const diffY = e.changedTouches[0].clientY - touchStartY.current;
    const absX = Math.abs(diffX);
    const absY = Math.abs(diffY);
    const swipeThreshold = 50;
    
    // Check scroll position for edge-based navigation
    const container = sentenceMode && sentencePage === 'analysis'
      ? document.querySelector<HTMLElement>('[data-sentence-analysis]')
      : scrollContainerRef.current;
    const scrollTop = container?.scrollTop || 0;
    const scrollHeight = container?.scrollHeight || 0;
    const clientHeight = container?.clientHeight || 0;
    const isAtTop = scrollTop <= 5;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5;
    
    // Vertical Swipe (Groups/Words) - edge-based detection
    const isVerticalSwipe = absY > absX * 1.5 && absY > swipeThreshold;
    
    // Use distance to distinguish short vs long swipes
    // Short swipe down (50-120px): show header
    // Long swipe down (>120px): navigate to previous/next word
    const shortSwipeMin = 50;
    const shortSwipeMax = 120;
    const longSwipeMin = 120;
    const horizontalSwipeMin = 60; // More sensitive for horizontal navigation
    const isShortSwipe = absY >= shortSwipeMin && absY < shortSwipeMax;
    const isLongSwipe = absY >= longSwipeMin;
    
    // Horizontal Swipe (Meanings) - more sensitive threshold
    const isHorizontalSwipe = absX > absY * 1.5 && absX > horizontalSwipeMin;

    // Tap detection (shared by sentence + word/phrase eyes-free zones). A "still" tap is a finger that
    // essentially didn't move; controls keep their own handlers so normal tapping still works.
    const TAP_MOVE_MAX = 10;     // px — finger essentially didn't move → it's a tap, not a swipe/scroll
    const isStillTap = absX <= TAP_MOVE_MAX && absY <= TAP_MOVE_MAX;
    const tapTarget = e.target as HTMLElement | null;
    const onControl = !!tapTarget?.closest(
      'button, a, [role="button"], input, textarea, select, label, [contenteditable="true"]'
    );
    const onSentenceWord = !!tapTarget?.closest('[data-word-offset]');

    // ── Sentence review mode (eyes-free, mirrors the word card): a still one-finger tap on blank space
    // toggles natural-voice playback — play → pause → resume; a double-tap marks the sentence remembered
    // (same as the item-review double-click). Clickable words and controls keep their own handlers;
    // ↑/↓ swipes still switch sentences. ──
    if (sentenceMode) {
      if (isHorizontalSwipe) {
        if (sentencePage === 'analysis') setSentencePage('sentence');
        else if (diffX < 0) setSentencePage('analysis');
        else if (isSentenceAutoPlayingRef.current) setShowSentenceAutoPlayPanel(true);
        else onClose();
        touchStartX.current = null;
        touchStartY.current = null;
        return;
      }
      // Match word review: normal drags only scroll. A long swipe changes sentences only after the
      // analysis has reached the corresponding boundary (or when the content is shorter than the page).
      if (sentencePage === 'analysis') {
        if (isStillTap && !onControl && !onSentenceWord) {
          suppressSentenceSurfaceClickUntilRef.current = Date.now() + 500;
          queueSentenceSurfaceTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
        } else if (isVerticalSwipe && isLongSwipe) {
          if (diffY < -longSwipeMin && (isAtBottom || scrollHeight <= clientHeight)) {
            goToSentence(currentGroupIndexRef.current + 1);
          } else if (diffY > longSwipeMin && isAtTop) {
            goToSentence(currentGroupIndexRef.current - 1);
          }
        }
        touchStartX.current = null;
        touchStartY.current = null;
        return;
      }
      if (isStillTap && !onControl && !onSentenceWord) {
        suppressSentenceSurfaceClickUntilRef.current = Date.now() + 500;
        queueSentenceSurfaceTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      } else if (isVerticalSwipe && isShortSwipe && diffY > 0 && isAtTop) {
        setShowHeader(true);                                    // keep short-swipe-down → reveal header
      } else if (isVerticalSwipe && isLongSwipe) {
        if (diffY < -longSwipeMin && (isAtBottom || scrollHeight <= clientHeight)) {
          goToSentence(currentGroupIndexRef.current + 1);      // swipe up → next sentence
        } else if (diffY > longSwipeMin && isAtTop) {
          goToSentence(currentGroupIndexRef.current - 1);      // swipe down → previous sentence
        }
      }
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }

    // ── Eyes-free zone tap (word-card / phrase view): a still one-finger tap on blank space reads by a
    // fixed SCREEN ZONE confined to the TOP HALF — top quarter = 1st example sentence, second quarter =
    // 2nd; the bottom half is left as empty/safe space (a tap there does nothing). Phrase → top quarter
    // = the phrase itself, second quarter = its first Key Vocabulary example (matching the on-screen
    // layout: phrase up top, vocab examples below). The zones are whole, fixed bands anchored to the top
    // edge (not small, position-shifting icons), so they work on an iPad without looking. Clickable
    // words, buttons and links are excluded so normal tapping still works; tapping the same zone again
    // pauses/resumes. ──
    if (isStillTap) {
      if (!onControl) {
        // Two stacked bands in the top half; the bottom half (zone -1) is inert empty space.
        const y = e.changedTouches[0].clientY;
        const zone = y < window.innerHeight / 4 ? 0 : y < window.innerHeight / 2 ? 1 : -1;
        if (zone >= 0) {
          flashZone(zone);
          if (currentItem && isPhraseItem(currentItem)) {
            const phrase = currentItem.data as SearchResult;
            const firstVocabExample = (phrase.vocabs || [])
              .flatMap(v => v.examples || [])
              .map(s => stripSentenceMarkers(s || '').trim())
              .find(Boolean);
            toggleSpeak(zone === 0 ? phrase.query : (firstVocabExample || phrase.query));
          } else {
            const count = examplesOf(currentItem).length;
            if (count > 0) {
              speakSentenceAt(Math.min(zone, count - 1)); // single example → either zone reads it
            }
          }
        }
      }
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }

    // Short swipe down at top -> show header bar
    if (isVerticalSwipe && isShortSwipe && diffY > 0 && isAtTop) {
      setShowHeader(true);
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    
    // Skip if swipe is too short for navigation
    if (!isLongSwipe && isVerticalSwipe) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }

    if (isVerticalSwipe && isLongSwipe && groups) {
      // Swipe UP -> Next Group (Word) - only when at bottom or content is short
      if (diffY < -longSwipeMin && hasNextGroup && (isAtBottom || scrollHeight <= clientHeight)) {
        setIsAutoPlaying(false);
        setShowHeader(false); // Hide header on navigation
        setCurrentGroupIndex(prev => prev + 1);
        setCurrentItemIndex(0); // Reset to first meaning
      }
      // Swipe DOWN -> Previous Group (Word) - only when at top
      else if (diffY > longSwipeMin && hasPrevGroup && isAtTop) {
        setIsAutoPlaying(false);
        setShowHeader(false); // Hide header on navigation
        setCurrentGroupIndex(prev => prev - 1);
        setCurrentItemIndex(0); // Reset to first meaning
      }
    }
    else if (isHorizontalSwipe) {
      const totalItems = currentGroup ? currentGroup.items.length : 0;
      
      // Swipe LEFT -> Next Item (Meaning)
      if (diffX < -horizontalSwipeMin && totalItems >= 1) {
        setIsAutoPlaying(false);
        if (totalItems === 1) {
          // Single meaning: just pronounce, no scroll/animation reset
          if (currentItem) {
            const wordToSpeak = currentItem.type === 'phrase'
              ? (currentItem.data as SearchResult).query
              : (currentItem.data as VocabCard).word;
            if (wordToSpeak) speakWord(wordToSpeak);
          }
        } else {
          setShowHeader(false);
          setCurrentItemIndex(prev => (prev + 1) % totalItems);
        }
      }
      
      // Swipe RIGHT -> Prev Item (Meaning) or Close
      if (diffX > horizontalSwipeMin) {
        setIsAutoPlaying(false);
        if (hasPrevItem) {
          setShowHeader(false); // Hide header on navigation
          setCurrentItemIndex(prev => prev - 1);
        } else {
          // Close view if swiping right with no previous item
          onClose();
        }
      }
    }
    
    touchStartX.current = null;
    touchStartY.current = null;
  };
  
  const title = type === 'phrase' ? (data as SearchResult).query : (data as VocabCard).word;

  // Saved + in-flight comparisons that involve THIS word — surfaced as a "Comparisons" section below
  // the card, so a "parable vs fable" comparison shows on both the parable and fable pages.
  const normTitle = (title || '').toLowerCase().trim();
  const wordComparisons = (comparisons || [])
    .filter((c) => c.words.some((w) => w.toLowerCase().trim() === normTitle))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const wordComparingPairs = (comparingKeys || []).filter((k) => k.split('|').includes(normTitle));

  // Auto-pronounce the word when the card changes — but NOT during sentence auto-play, which
  // reads the example sentence instead (we don't want the word spoken over it).
  useEffect(() => {
    if (!title || isSentenceAutoPlaying || sentenceMode) return;

    // Small delay to let animation settle before pronouncing
    const timer = setTimeout(() => {
      speakWord(title);
    }, 100);

    return () => clearTimeout(timer);
  }, [title, currentGroupIndex, currentItemIndex, isSentenceAutoPlaying, sentenceMode]);

  // In sentence review, warm the CURRENT sentence's audio + word timings so a double-click / Enter seek
  // is reliable. ensureTimings also kicks off background generation if this sentence has no timings yet
  // (whisper cold-start is ~a minute) so they're ready by the time the user goes to seek.
  useEffect(() => {
    if (sentenceMode && currentSentenceText) {
      prefetchTTS([currentSentenceText]);
      ensureTimings(currentSentenceText);
    }
  }, [sentenceMode, currentSentenceText, prefetchSpeechStyle]);

  // Aggressively stage the next five sentence cards while the learner is reading the current one.
  // Audio (including word timings) is persisted in the dedicated IDB cache; their pictures are warmed below.
  useEffect(() => {
    if (!sentenceMode || sentencePreloadWindow.length <= 1) return;
    const texts = sentencePreloadWindow.slice(1).map(item => (item.data as SentenceData).text).filter(Boolean);
    const warm = () => { void preloadAudio(texts); };
    warm();
    // A failed warm-up is retried as soon as a flaky connection comes back, even if the learner has
    // stayed on the same sentence throughout the outage.
    window.addEventListener('online', warm);
    return () => window.removeEventListener('online', warm);
  }, [sentenceMode, sentencePreloadWindow, prefetchSpeechStyle]);

  // The cards the learner can move to next: the next five sentences in sentence review; this word's other
  // meanings and the words either side otherwise. Their pictures are decoded ahead, so each paints on its
  // first frame.
  const upcomingItems = useMemo(() => {
    if (sentenceMode) return sentencePreloadWindow.slice(1);
    if (!groups?.length) return [];
    const index = Math.min(currentGroupIndex, groups.length - 1);
    return [groups[index], groups[index + 1], groups[index - 1]].flatMap(group => group?.items ?? []);
  }, [sentenceMode, sentencePreloadWindow, groups, currentGroupIndex]);
  useWarmImages(upcomingItems, onLazyLoadImage);

  // Warm the TTS cache for the example SENTENCES of this word and the words either side (the word itself
  // uses the system voice), so tapping one or auto-play right after moving a card plays at once, through
  // the iOS-unlocked <audio> element. Sentence review stages its own audio above.
  useEffect(() => {
    if (sentenceMode) return;
    const sentences = upcomingItems.flatMap(item => isVocabItem(item)
      ? item.data.examples ?? []
      : isPhraseItem(item) ? (item.data.vocabs ?? []).flatMap(vocab => vocab.examples ?? []) : []).filter(Boolean);
    if (sentences.length) prefetchTTS(sentences);
  }, [sentenceMode, upcomingItems, prefetchSpeechStyle]);

  // P key to pronounce current word
  // Moved to bottom to access handlers
  
  // Find saved item - first try by ID (most reliable), then fallback to title+sense matching
  const savedItemMatch = useMemo(() =>
    savedItems.find(item => item.data.id === data.id) ||
    savedItems.find(item =>
      getItemTitle(item).toLowerCase().trim() === (title || '').toLowerCase().trim() &&
      (item.type === 'phrase' || (item.data as VocabCard).sense === (data as VocabCard).sense)
    ),
    [savedItems, data.id, title, type]
  );
  const isSaved = !!savedItemMatch;

  // Get mastery info for current item
  const mastery = savedItemMatch?.srs ? SRSAlgorithm.getMasteryLevel(savedItemMatch.srs) : null;
  const masteryColors = mastery ? getMasteryColors(mastery.color) : null;

  const handleToggleSave = useCallback(() => {
    if (isSaved && savedItemMatch) {
      onDelete(savedItemMatch.data.id);
    } else {
      if (!data.id) return;
      
      onSave({
        data: data,
        type: type,
        savedAt: Date.now(),
        srs: SRSAlgorithm.createNew(data.id, type)
      });
    }
  }, [isSaved, savedItemMatch, data, type, onDelete, onSave]);

  // Cmd/Ctrl+S only ever saves: it does nothing on a card that's already saved, while typing, or in sentence
  // review, where the card behind the sentence is its source word rather than anything on screen.
  const handleSaveShortcut = useCallback(() => {
    if (sentenceModeRef.current || isSaved || isTypingTarget(document.activeElement)) return;
    handleToggleSave();
  }, [isSaved, handleToggleSave]);

  // Navigation handlers for keyboard
  const handlePrevItem = useCallback(() => {
    if (hasPrevItem) {
      setIsAutoPlaying(false);
      setCurrentItemIndex(prev => prev - 1);
    }
  }, [hasPrevItem]);

  const handleNextItem = useCallback(() => {
    const totalItems = currentGroup ? currentGroup.items.length : 0;
    if (totalItems >= 1) {
      setIsAutoPlaying(false);
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
  }, [currentGroup, currentItem]);

  const handlePrevGroup = useCallback(() => {
    if (hasPrevGroup && groups) {
      setIsAutoPlaying(false);
      setCurrentGroupIndex(prev => prev - 1);
      setCurrentItemIndex(0);
    }
  }, [hasPrevGroup, groups]);

  const handleNextGroup = useCallback(() => {
    if (hasNextGroup && groups) {
      setIsAutoPlaying(false);
      setCurrentGroupIndex(prev => prev + 1);
      setCurrentItemIndex(0);
    }
  }, [hasNextGroup, groups]);

  // Keep the screen awake while EITHER auto-play mode is active, so the phone doesn't
  // auto-dim/lock and pause playback. Wake lock auto-releases when the tab is hidden, so we
  // re-acquire on visibilitychange. (Requires HTTPS + iOS 16.4+; manual lock still suspends.)
  useEffect(() => {
    if (!isAutoPlaying && !isSentenceAutoPlaying) return;
    const wakeLockApi = (navigator as any).wakeLock;
    if (!wakeLockApi?.request) return;

    let sentinel: any = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await wakeLockApi.request('screen');
        if (cancelled) { lock.release?.(); return; }
        sentinel = lock;
      } catch {
        // Ignore — user may have denied, or document not visible
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinel) acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      sentinel?.release?.();
      sentinel = null;
    };
  }, [isAutoPlaying, isSentenceAutoPlaying]);

  // Auto-play slideshow effect
  const autoPlaySpeedRef = useRef(autoPlaySpeed);
  useEffect(() => { autoPlaySpeedRef.current = autoPlaySpeed; }, [autoPlaySpeed]);

  // Counts displays of the current group during auto-play. Single-meaning words
  // need a second display to satisfy "play each word at least twice".
  const [groupPlayCount, setGroupPlayCount] = useState(1);
  // Reads the count from the render that moved, and resets it only when needed (see the group reset above).
  useEffect(() => { if (groupPlayCount !== 1) setGroupPlayCount(1); }, [currentGroupIndex, isAutoPlaying]);

  useEffect(() => {
    if (!isAutoPlaying || !groups) return;

    const timer = setTimeout(() => {
      const safeGroupIdx = Math.min(currentGroupIndex, groups.length - 1);
      const group = groups[safeGroupIdx];
      if (!group) { setIsAutoPlaying(false); return; }

      const safeItemIdx = Math.min(currentItemIndex, group.items.length - 1);
      const isLastItem = safeItemIdx >= group.items.length - 1;
      const isLastGroup = safeGroupIdx >= groups.length - 1;
      const needsRepeat = isLastItem && group.items.length < 2 && groupPlayCount < 2;

      if (!isLastItem) {
        // Advance to next meaning within current group
        setCurrentItemIndex(prev => prev + 1);
        setGroupPlayCount(prev => prev + 1);
      } else if (needsRepeat) {
        // Single-meaning word: show it for another turn and re-pronounce
        setGroupPlayCount(prev => prev + 1);
        if (title) speakWord(title);
      } else if (!isLastGroup) {
        // Advance to next group (word)
        setCurrentGroupIndex(prev => prev + 1);
        setCurrentItemIndex(0);
      } else {
        // Reached the end
        setIsAutoPlaying(false);
      }
    }, autoPlaySpeedRef.current);

    return () => clearTimeout(timer);
  }, [isAutoPlaying, currentGroupIndex, currentItemIndex, groups, groupPlayCount]);

  const SPEED_PRESETS = [1000, 1500, 2000, 3000, 5000];
  const TIMER_PRESETS = [5, 10, 15, 20, 25];

  const cycleSpeed = useCallback(() => {
    setAutoPlaySpeed(prev => {
      const idx = SPEED_PRESETS.indexOf(prev);
      return SPEED_PRESETS[(idx + 1) % SPEED_PRESETS.length];
    });
  }, []);

  const cycleTimerDuration = useCallback(() => {
    setAutoPlayTimerMinutes(prev => {
      const idx = TIMER_PRESETS.indexOf(prev);
      return TIMER_PRESETS[(idx + 1) % TIMER_PRESETS.length];
    });
  }, []);

  const toggleAutoPlay = useCallback(() => {
    setIsAutoPlaying(prev => {
      const next = !prev;
      if (next) setIsSentenceAutoPlaying(false); // the two auto-play modes are mutually exclusive
      return next;
    });
  }, []);

  // ── Sentence auto-play: read each card's example sentences (both) in turn (neural voice) ──
  const GAP_PRESETS = [2000, 3000, 5000, 10000];
  const cycleGap = useCallback(() => {
    setSentenceGap(prev => {
      const idx = GAP_PRESETS.indexOf(prev);
      return GAP_PRESETS[(idx + 1) % GAP_PRESETS.length];
    });
  }, []);

  // How many times each sentence is read (total), cycled 1 → 5 → 1.
  const REPEAT_PRESETS = [1, 2, 3, 4, 5];
  const cycleRepeats = useCallback(() => {
    setSentenceRepeats(prev => {
      const idx = REPEAT_PRESETS.indexOf(prev);
      return REPEAT_PRESETS[(idx + 1) % REPEAT_PRESETS.length];
    });
  }, []);

  const toggleSentenceAutoPlay = useCallback(() => {
    setIsSentenceAutoPlaying(prev => {
      const next = !prev;
      if (next) setIsAutoPlaying(false);
      return next;
    });
    // Prime the silent keep-alive inside this user gesture so iOS unlocks it (the registration effect's
    // acquire runs after paint, outside the gesture). Priming takes no hold — the media-session effect's
    // acquire/release pair owns the lifecycle. Harmless when stopping — that effect's cleanup releases it.
    primeKeepAlive();
  }, []);

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

  // Sentences to read for a card during auto-play: a phrase's query, or a vocab card's example
  // sentences (capped at 2 for E/autoplay and eyes-free zones). Direct Cmd+1–4 playback uses the
  // complete example list through speakSentenceAt below. Stripped, empties dropped.
  const examplesOf = (item: StoredItem | null): string[] => {
    if (!item) return [];
    if (isPhraseItem(item)) {
      const q = stripSentenceMarkers((item.data as SearchResult).query || '');
      return q ? [q] : [];
    }
    const ex = (item.data as VocabCard).examples;
    return (Array.isArray(ex) ? ex.slice(0, 2) : []).map(stripSentenceMarkers).filter(Boolean);
  };

  // The session to preload once sentence auto-play starts (see SessionPreload): the saved sentences in
  // sentence mode, else every card's example sentences, and the pictures the session shows.
  const getPreloadSession = (): PreloadSession => {
    const sessionItems = sentenceMode ? (sentenceItems ?? []) : (groups ?? []).flatMap(g => g.items);
    const texts = sentenceMode
      ? sessionItems.map(s => (s.data as SentenceData).text || '')
      : sessionItems.flatMap(item => examplesOf(item));
    const images = new Map<string, string | undefined>();
    for (const item of sessionItems) {
      const imageUrl = getItemImageUrl(item);
      if (imageUrl === 'idb:stored' || imageUrl?.startsWith('server:has_image:')) {
        images.set(item.data.id, serverImageVersion(imageUrl));
      }
    }
    return { texts, images };
  };

  const sentenceGapRef = useRef(sentenceGap);
  useEffect(() => { sentenceGapRef.current = sentenceGap; }, [sentenceGap]);
  const sentenceRepeatsRef = useRef(sentenceRepeats);
  useEffect(() => { sentenceRepeatsRef.current = sentenceRepeats; }, [sentenceRepeats]);

  const recordSentenceExposure = useCallback((expectedSentenceId?: string) => {
    const sentence = currentSentenceRef.current;
    if (!sentence || (expectedSentenceId && sentence.data.id !== expectedSentenceId)) return;
    const sentenceData = sentence.data as SentenceData;
    // Listening to an unsaved word-card preview must not silently save it. Catalog previews already
    // have stable progress identities and are intentionally persisted like ordinary saved sentences.
    if (sentence.data.id.startsWith('sentence-preview:') && !sentenceData.catalogSentenceId) return;
    const now = Date.now();
    const speechStyle = getTtsStyle();
    const updated: StoredItem = {
      ...sentence,
      data: sentenceData.preferredSpeechStyle === speechStyle
        ? sentenceData
        : { ...sentenceData, preferredSpeechStyle: speechStyle },
      srs: SRSAlgorithm.updateAfterExposure(sentence.srs, now),
      updatedAt: now,
    };
    currentSentenceRef.current = updated;
    onSave(updated);
  }, [onSave]);

  // Autoplay pause/resume across the inter-read GAP (not just mid-clip): the media-session /
  // Bluetooth pause must stop autoplay even between reads. autoPlayPausedRef gates the gap
  // scheduler; when paused mid-gap the pending continuation is stashed in resumeChainRef and
  // replayed on resume; cancelGapRef holds the live gap canceller so pause can abort it.
  const autoPlayPausedRef = useRef(false);
  const resumeChainRef = useRef<(() => void) | null>(null);
  const cancelGapRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isSentenceAutoPlaying || !groups) return;

    // Lock-screen "now playing" for this card/sentence (refreshed as autoplay advances).
    setMediaMetadata({
      title: (sentenceMode ? stripSentenceMarkers(currentSentenceText || '') : title) || 'DictProp',
      artist: sentenceMode ? ((currentSentence?.data as SentenceData)?.sourceWord || 'DictProp') : 'DictProp',
      album: 'DictProp',
      artworkUrl: (() => { const u = getItemImageUrl(currentItem); return u && u.startsWith('data:image') ? u : undefined; })(),
    });

    const advanceCard = () => {
      const safeGroupIdx = Math.min(currentGroupIndex, groups.length - 1);
      const group = groups[safeGroupIdx];
      if (!group) { setIsSentenceAutoPlaying(false); return; }
      const safeItemIdx = Math.min(currentItemIndex, group.items.length - 1);
      const isLastItem = safeItemIdx >= group.items.length - 1;
      const isLastGroup = safeGroupIdx >= groups.length - 1;
      if (!isLastItem) {
        setCurrentItemIndex(p => p + 1);
      } else if (!isLastGroup) {
        setCurrentGroupIndex(p => p + 1);
        setCurrentItemIndex(0);
      } else {
        setIsSentenceAutoPlaying(false); // played the last card → stop
      }
    };

    // In sentence mode, read this card's saved sentence; otherwise read ALL of the card's example
    // sentences (both) in turn, then advance to the next card.
    const sentences = sentenceMode
      ? [stripSentenceMarkers(currentSentenceText)].filter(Boolean)
      : examplesOf(currentItem);
    let cancelGap: (() => void) | undefined; // background-safe inter-read gap (afterGap) — see neuralTts
    let handle: SpeakHandle | undefined;
    let idx = 0;
    let rep = 0;
    let successfulReads = 0;

    // A fresh run (autoplay start or a next/prev navigation) always plays; only an explicit pause holds it.
    autoPlayPausedRef.current = false;
    resumeChainRef.current = null;
    cancelGapRef.current = null;

    // Schedule the next step after `ms`. When autoplay is paused (media-session / Bluetooth), the
    // continuation is stashed in resumeChainRef instead of arming the timer, so resume picks up exactly
    // where it left off; the live canceller is mirrored to cancelGapRef so onPause can abort a running
    // gap even BETWEEN reads (not just mid-clip). See the media-session effect below.
    const schedule = (ms: number, fn: () => void) => {
      resumeChainRef.current = fn; // remembered in case we pause during this gap
      if (autoPlayPausedRef.current) { cancelGapRef.current = null; return; }
      const run = () => { cancelGapRef.current = null; resumeChainRef.current = null; fn(); };
      cancelGap = afterGap(ms, run);
      cancelGapRef.current = cancelGap;
    };

    // Deliberate action → allow the one-time model download. Each sentence is read `sentenceRepeats`
    // times (total); the configurable gap sits between EVERY read — both repeats of the same sentence
    // and distinct sentences. Advancing to the NEXT card in item mode uses a short beat instead. (In
    // sentence mode each card is a single saved sentence, so the configurable gap applies across cards.)
    const CARD_GAP = 600; // short beat between cards in item mode
    const playNext = () => {
      if (idx >= sentences.length) { schedule(CARD_GAP, advanceCard); return; }
      const s = sentences[idx];
      const afterEach = () => {
        if (++rep < sentenceRepeatsRef.current) { schedule(sentenceGapRef.current, playNext); return; } // read again
        rep = 0;
        successfulReads = 0;
        idx++;
        const more = idx < sentences.length;
        const gap = (more || sentenceModeRef.current) ? sentenceGapRef.current : CARD_GAP;
        schedule(gap, more ? playNext : advanceCard);
      };
      const afterSuccessfulRead = () => {
        successfulReads++;
        const completesSuccessfulRound = rep + 1 >= sentenceRepeatsRef.current &&
          successfulReads >= sentenceRepeatsRef.current;
        if (sentenceModeRef.current && completesSuccessfulRound) recordSentenceExposure();
        afterEach();
      };
      handle = speakNatural(s, { allowDownload: true, onEnd: afterSuccessfulRead, onError: afterEach });
    };

    if (!sentences.length) {
      schedule(400, advanceCard); // card has no example → move on quickly
    } else {
      playNext();
    }

    return () => {
      handle?.stop();
      cancelGap?.();
      cancelGapRef.current = null;
      resumeChainRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSentenceAutoPlaying, currentGroupIndex, currentItemIndex, groups]);

  // Timer: stamp start time on play, clear on stop (covers both word- and sentence-autoplay)
  useEffect(() => {
    setAutoPlayStartedAt((isAutoPlaying || isSentenceAutoPlaying) ? Date.now() : null);
  }, [isAutoPlaying, isSentenceAutoPlaying]);

  // Stop auto-play when the timer expires. The check sets no state until then, so the card doesn't
  // re-render every second; AutoPlayCountdown shows the time left.
  useEffect(() => {
    if ((!isAutoPlaying && !isSentenceAutoPlaying) || autoPlayStartedAt === null) return;
    const interval = setInterval(() => {
      if (Date.now() - autoPlayStartedAt >= autoPlayTimerMinutes * 60_000) {
        setIsAutoPlaying(false);
        setIsSentenceAutoPlaying(false);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isAutoPlaying, isSentenceAutoPlaying, autoPlayStartedAt, autoPlayTimerMinutes]);

  const countdownStartedAt = isAutoPlaying || isSentenceAutoPlaying ? autoPlayStartedAt : null;

  // Fresh ref to the on-screen card so the keyboard readers below read current data without re-subscribing.
  const currentItemRef = useRef(currentItem);
  useEffect(() => { currentItemRef.current = currentItem; });

  // ── Manual sentence reading — all speech funnels through the shared playback state (neuralTts), so
  // the megaphone icons stay in sync and a second press can pause / resume / restart what's playing. ──

  // E: read the displayed card's example sentences in turn (or, in sentence mode, the saved sentence).
  // Press again to pause; once more to resume.
  const readBothSentences = useCallback(() => {
    let sentences: string[];
    let exposureSentenceId: string | undefined;
    if (sentenceModeRef.current && currentSentenceRef.current) {
      exposureSentenceId = currentSentenceRef.current.data.id;
      sentences = [stripSentenceMarkers((currentSentenceRef.current.data as SentenceData).text)].filter(Boolean);
    } else {
      const item = currentItemRef.current;
      if (!item) return;
      const ex = isPhraseItem(item)
        ? [(item.data as SearchResult).query]
        : ((item.data as VocabCard).examples || []);
      sentences = (ex as string[]).slice(0, 2).map(s => stripSentenceMarkers(s || '').trim()).filter(Boolean);
    }
    if (!sentences.length) return;

    // Continuous sentence autoplay owns the audio chain until its explicit Stop control is used.
    // Keyboard/manual read commands may pause or resume its current clip, but never replace the chain.
    if (sentenceModeRef.current && isSentenceAutoPlayingRef.current) {
      const status = getPlaybackState().status;
      if (status === 'playing') pauseCurrent();
      else if (status === 'paused') resumeCurrent();
      return;
    }

    // Already reading one of these → toggle pause / resume.
    const pb = getPlaybackState();
    if (pb.text && sentences.includes(pb.text) && (pb.status === 'playing' || pb.status === 'paused')) {
      if (pb.status === 'playing') pauseCurrent(); else resumeCurrent();
      return;
    }

    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    let idx = 0;
    let handle: SpeakHandle | undefined;
    const playNext = () => {
      if (idx >= sentences.length) return;
      if (handle && !handle.isActive()) return; // superseded by other speech / navigation → stop the chain
      const s = sentences[idx++];
      handle = speakNatural(s, {
        allowDownload: true,
        onEnd: () => {
          if (exposureSentenceId) recordSentenceExposure(exposureSentenceId);
          setTimeout(playNext, 400);               // small breath between the two sentences
        },
        onError: () => setTimeout(playNext, 400),
      });
    };
    playNext();
  }, [recordSentenceExposure]);

  // Toggle natural-voice playback for an arbitrary sentence, routed through the shared playback state so
  // the megaphone icons stay in sync: same clip already playing → pause; paused → resume; almost done →
  // restart from the top; otherwise start fresh. Shared by the Cmd+1–4 readers and eyes-free zone tap.
  const toggleSpeak = useCallback((raw: string) => {
    const sentence = stripSentenceMarkers(raw || '').trim();
    if (!sentence) return;
    const pb = getPlaybackState();
    if (pb.text === sentence) {
      if (pb.status === 'loading') return;                          // already starting this very sentence
      if (pb.status === 'paused') { resumeCurrent(); return; }
      // Mid-clip → pause; almost done → fall through and restart from the top.
      if (pb.status === 'playing' && getPlaybackProgress() < 0.85) { pauseCurrent(); return; }
    }
    if (sentenceModeRef.current && isSentenceAutoPlayingRef.current) return;
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    speakNatural(sentence, { allowDownload: true });
  }, []);

  // Cmd/Ctrl+1–4: read the corresponding example sentence (a phrase has one: its query). A second
  // press on the same sentence pauses/resumes unless it is almost finished, when it restarts.
  const speakSentenceAt = useCallback((index: number) => {
    const item = currentItemRef.current;
    if (!item) return;
    const ex = isPhraseItem(item)
      ? [(item.data as SearchResult).query]
      : ((item.data as VocabCard).examples || []);
    toggleSpeak((ex as string[])[index] || '');
  }, [toggleSpeak]);

  // ── Sentence review mode: speak the saved sentence, or switch to another and speak it immediately ──
  // Shared by the swipe gestures and the arrow keys / trackpad wheel below.
  const speakCurrentSentence = useCallback(() => {
    const s = currentSentenceRef.current;
    if (!s) return;
    const sentence = stripSentenceMarkers((s.data as SentenceData).text || '').trim();
    if (!sentence) return;
    if (isSentenceAutoPlayingRef.current) return;
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    speakNatural(sentence, {
      allowDownload: true,
      onEnd: () => recordSentenceExposure(s.data.id),
    });
  }, [recordSentenceExposure]);

  // Tap the sentence (or context-aware Space): pause it if it's playing, resume if paused, otherwise
  // (re)start it from the top. Routed through the shared playback state so it stays in sync with the
  // megaphone button — whoever started the audio, this controls it.
  const toggleSentencePlayback = useCallback(() => {
    const s = currentSentenceRef.current;
    if (!s) return;
    const sentence = stripSentenceMarkers((s.data as SentenceData).text || '').trim();
    if (!sentence) return;
    const pb = getPlaybackState();
    if (pb.text === sentence) {
      if (pb.status === 'loading') return;                       // already starting this one
      if (pb.status === 'playing') { pauseCurrent(); return; }
      if (pb.status === 'paused') { resumeCurrent(); return; }
    }
    if (isSentenceAutoPlayingRef.current) return;
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    speakNatural(sentence, {
      allowDownload: true,
      onEnd: () => recordSentenceExposure(s.data.id),
    });
  }, [recordSentenceExposure]);

  // Play the current sentence starting at a clicked/selected word (by its char offset in the stripped
  // sentence). If this sentence's clip is already the active audio, seek it in place (seamless);
  // otherwise (re)start the sentence and seek once it's playing. Falls back to reading the remainder
  // when no word timings are available (legacy clip / in-browser / system voice).
  const playFromWordOffset = useCallback(async (offset: number) => {
    const s = currentSentenceRef.current;
    if (!s) return;
    const stripped = stripSentenceMarkers((s.data as SentenceData).text || '').trim();
    if (!stripped) return;
    // Resolve timings up-front (instant if warmed on mount, else a quick fetch) and compute the start
    // time BEFORE playing — avoids the start-from-zero-then-late-seek race.
    const timings = await getTimingsFor(stripped);
    const startAt = timings ? seekTimeForOffset(alignWordsToStripped(stripped, timings), offset) : null;
    const pb = getPlaybackState();
    if (pb.text === stripped && (pb.status === 'playing' || pb.status === 'paused') && startAt != null) {
      seekCurrent(startAt); // already this sentence's clip → seek in place (seamless)
      if (pb.status === 'paused') resumeCurrent();
      return;
    }
    if (isSentenceAutoPlayingRef.current) return;
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    // Timings can be absent for a legacy/system-voice clip or during a flaky-network timeout. Reading
    // the remaining text is a prosody compromise, but it preserves the interaction's core promise:
    // Command-click starts audibly at the selected word rather than unexpectedly returning to word one.
    const fallbackRemainder = stripped.slice(Math.max(0, offset)).trimStart();
    const textToSpeak = startAt == null && fallbackRemainder ? fallbackRemainder : stripped;
    speakNatural(textToSpeak, {
      allowDownload: true,
      startAt: startAt ?? undefined,
      onEnd: () => recordSentenceExposure(s.data.id),
    }); // (re)start AT the word
  }, [recordSentenceExposure]);

  // Enter (sentence mode): play from the word the caret/selection sits in. No-op if not in a word, so
  // it never hijacks Enter elsewhere. Words carry data-word-offset (see HighlightedSentence).
  const handleEnterFromSelection = useCallback(() => {
    if (!sentenceModeRef.current) return;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    const node: Node | null = sel?.anchorNode ?? null;
    let el: HTMLElement | null = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
    while (el && !(el.hasAttribute && el.hasAttribute('data-word-offset'))) el = el.parentElement;
    if (!el) return;
    const off = Number(el.getAttribute('data-word-offset'));
    if (Number.isFinite(off)) playFromWordOffset(off);
  }, [playFromWordOffset]);

  const goToSentence = useCallback((nextIndex: number) => {
    const list = sentenceItemsRef.current ?? [];
    if (list.length === 0) return;
    const clamped = Math.max(0, Math.min(nextIndex, list.length - 1));
    const keepAutoPlaying = isSentenceAutoPlayingRef.current;
    if (clamped === currentGroupIndexRef.current) {
      if (!keepAutoPlaying) speakCurrentSentence(); // already at an end → re-speak outside autoplay
      return;
    }
    setIsAutoPlaying(false);
    setShowHeader(false);
    setCurrentGroupIndex(clamped);
    setCurrentItemIndex(0);
    const next = list[clamped];
    const sentence = next ? stripSentenceMarkers((next.data as SentenceData).text || '').trim() : '';
    const nextSpeechStyle = next ? (next.data as SentenceData).preferredSpeechStyle : undefined;
    if (nextSpeechStyle) setTtsStyle(nextSpeechStyle);
    // The autoplay effect restarts itself at the selected sentence after the index changes. Starting a
    // separate manual clip here would supersede that chain and leave autoplay visually on but stalled.
    if (!keepAutoPlaying && sentence && next) {
      speakNatural(sentence, {
        allowDownload: true,
        onEnd: () => recordSentenceExposure(next.data.id),
      });
    }
  }, [recordSentenceExposure, speakCurrentSentence]);

  // Arrow keys / trackpad wheel: sentence mode uses ←/→ for its two pages and ↑/↓ for
  // sentence navigation. Page changes deliberately leave the shared speech session untouched.
  const navLeft = useCallback(() => { if (sentenceModeRef.current) setSentencePage('sentence'); else handlePrevItem(); }, [handlePrevItem]);
  const navRight = useCallback(() => { if (sentenceModeRef.current) setSentencePage('analysis'); else handleNextItem(); }, [handleNextItem]);
  const navUp = useCallback(() => { if (sentenceModeRef.current) goToSentence(currentGroupIndexRef.current - 1); else handlePrevGroup(); }, [handlePrevGroup, goToSentence]);
  const navDown = useCallback(() => { if (sentenceModeRef.current) goToSentence(currentGroupIndexRef.current + 1); else handleNextGroup(); }, [handleNextGroup, goToSentence]);

  // Sentence review's auto-play is locked on, so leaving it opens the panel with its Stop button. That panel
  // is sentence review's own; a word card's example auto-play simply ends with the view.
  const requestSentenceExit = useCallback(() => {
    if (isSentenceAutoPlaying && sentenceMode) {
      setShowSentenceAutoPlayPanel(true);
      return;
    }
    onClose();
  }, [isSentenceAutoPlaying, sentenceMode, onClose]);

  // Stop any playback when DetailView closes (covers a manual read still going at close time).
  useEffect(() => () => { stopCurrent(); }, []);

  // Background sentence autoplay — while it runs, hold the audio session open (silent keep-alive) and
  // expose lock-screen controls so the installed PWA keeps reading sentences with the screen off.
  // next/prev just bump the index (the autoplay effect re-runs and continues); they don't stop autoplay.
  useEffect(() => {
    if (!isSentenceAutoPlaying) return;
    acquireKeepAlive();
    const step = (delta: number) => {
      const len = sentenceModeRef.current ? (sentenceItemsRef.current?.length ?? 0) : (groups?.length ?? 0);
      if (!len) return;
      const cur = currentGroupIndexRef.current;
      const nextIdx = Math.max(0, Math.min(cur + delta, len - 1));
      if (nextIdx === cur) return;
      autoPlayPausedRef.current = false;   // a next/prev while paused resumes playback at the new sentence
      resumeChainRef.current = null;
      setCurrentGroupIndex(nextIdx);
      setCurrentItemIndex(0);
    };
    setMediaSessionHandlers({
      onPlay: () => {
        autoPlayPausedRef.current = false;
        if (getPlaybackState().status === 'paused') { resumeCurrent(); return; } // resume a mid-clip pause
        const cont = resumeChainRef.current;                                     // resume a gap that was paused
        resumeChainRef.current = null;
        cont?.();
      },
      onPause: () => {
        autoPlayPausedRef.current = true;
        const st = getPlaybackState().status;
        if (st === 'playing' || st === 'loading') { pauseCurrent(); return; }    // pause the current read
        cancelGapRef.current?.();                                                // between reads → abort the pending gap
        cancelGapRef.current = null;
      },
      onStop: () => setIsSentenceAutoPlaying(false),
      onNext: () => step(1),
      onPrev: () => step(-1),
    });
    return () => {
      setMediaSessionHandlers(null);
      releaseKeepAlive();
    };
  }, [isSentenceAutoPlaying, groups]);

  // Escape closes one thing at a time: the action menu, an open panel, the analysis page, then the view. A
  // search sheet or dialog above the view takes Escape first; an example preview on top is its own layer.
  useEscapeLayer(() => {
    if (showActionMenu) {
      setShowActionMenu(false);
      moreActionsRef.current?.querySelector('button')?.focus();
    } else if (showImagePanel) {
      setShowImagePanel(false);
    } else if (showSentenceAutoPlayPanel) {
      setShowSentenceAutoPlayPanel(false);
    } else if (sentencePage === 'analysis') {
      setSentencePage('sentence');
    } else {
      requestSentenceExit();
    }
  }, 50, !detailInteractionLocked);

  // Keyboard navigation
  useKeyboardNavigation({
    onArrowLeft: navLeft,
    onArrowRight: navRight,
    onArrowUp: navUp,
    onArrowDown: navDown,
    onEnter: handleEnterFromSelection,
    onSave: handleSaveShortcut,
    enabled: !showActionMenu && !detailInteractionLocked,
  });

  // Enter and Space press a button or link the keyboard focused. The shortcut listeners on window would take
  // those keys for the view (Enter reads from the selected word, Space toggles auto-play) and cancel the
  // press, so they're stopped on the way up. Clicked controls keep the shortcuts (see isKeyboardFocusedControl).
  useEffect(() => {
    if (showActionMenu || detailInteractionLocked) return;
    const passToFocusedControl = (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && isKeyboardFocusedControl(e.target)) e.stopPropagation();
    };
    document.addEventListener('keydown', passToFocusedControl);
    return () => document.removeEventListener('keydown', passToFocusedControl);
  }, [showActionMenu, detailInteractionLocked]);

  // Trackpad wheel navigation
  useWheelNavigation({
    onScrollLeft: navLeft,
    onScrollRight: navRight,
    containerRef: scrollContainerRef,
    threshold: 80,
    enabled: !detailInteractionLocked && !!(currentGroup && currentGroup.items.length >= 1),
  });

  // Mobile sentence words have fixed gestures: one finger uses the normal lookup action rendered by
  // HighlightedSentence; holding a finger anywhere and touching a word with another plays from its offset.
  const handleMobileWordTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    if (!isMobile || e.touches.length < 2) return;
    const target = e.target instanceof Element ? e.target : null;
    const word = target?.closest('[data-word-offset]') as HTMLElement | null;
    if (!word || !e.currentTarget.contains(word)) return;
    const offset = Number(word.dataset.wordOffset);
    if (!Number.isFinite(offset)) return;
    e.preventDefault();
    e.stopPropagation();
    mobileWordChordActiveRef.current = true;
    suppressMobileWordClickUntilRef.current = Date.now() + 800;
    lastSentenceTapRef.current = null;
    void playFromWordOffset(offset);
  };

  const suppressMobileChordClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!mobileWordChordActiveRef.current && Date.now() >= suppressMobileWordClickUntilRef.current) return;
    e.preventDefault();
    e.stopPropagation();
  };

  // macOS equivalent of the iPhone/iPad two-finger word chord: Command-click always starts at the
  // clicked word. Capture the click before HighlightedSentence applies its ordinary click action, so
  // this remains available in both look-up mode and the optional one-click playback mode.
  const handleSentenceWordClickCapture = (e: React.MouseEvent<HTMLElement>) => {
    if (isMobile) {
      suppressMobileChordClick(e);
      return;
    }
    if (!isMacDesktop || !e.metaKey) return;
    const target = e.target instanceof Element ? e.target : null;
    const word = target?.closest('[data-word-offset]') as HTMLElement | null;
    if (!word || !e.currentTarget.contains(word)) return;
    const offset = Number(word.dataset.wordOffset);
    if (!Number.isFinite(offset)) return;
    e.preventDefault();
    e.stopPropagation();
    void playFromWordOffset(offset);
  };

  const handleDeleteItem = () => {
    // Sentence mode: delete the SENTENCE (App removes its group + advances/closes the flow).
    if (sentenceMode && currentSentence) {
      if (isSentencePreview) return;
      log('🗑️ DetailView: Deleting sentence:', currentSentence.data.id);
      setShowActionMenu(false);
      onDelete(currentSentence.data.id);
      return;
    }
    // Use savedItemMatch ID if available, otherwise use currentItem's ID
    const idToDelete = savedItemMatch?.data.id || data.id;
    if (!idToDelete) {
      warn('Delete failed: No valid ID found');
      return;
    }

    log('🗑️ DetailView: Deleting item:', idToDelete, title);
    setShowActionMenu(false);

    // App.tsx handles updating detailContext and navigation
    onDelete(idToDelete);
  };

  const handleArchiveItem = () => {
    if (!onArchive) return;
    
    // Use savedItemMatch ID if available, otherwise use currentItem's ID
    const idToArchive = savedItemMatch?.data.id || data.id;
    if (!idToArchive) {
      warn('Archive failed: No valid ID found');
      return;
    }
    
    log('📦 DetailView: Archiving item:', idToArchive, title);
    setShowActionMenu(false);
    
    // App.tsx handles updating detailContext and navigation
    onArchive(idToArchive);
  };

  const handleUnarchiveItem = () => {
    if (!onUnarchive || !savedItemMatch?.isArchived) return;
    setShowActionMenu(false);
    onUnarchive(savedItemMatch.data.id);
  };

  const handleResetSRS = useCallback(() => {
    // Sentence mode: reset just this sentence's SRS.
    if (sentenceModeRef.current && currentSentenceRef.current) {
      if (isSentencePreview) return;
      const s = currentSentenceRef.current;
      log('🔄 DetailView: Resetting SRS for sentence:', s.data.id);
      // A catalog sentence isn't in the library yet; saving it with fresh progress adds it.
      if (!onResetSRS?.(s.data.id)) onSave({ ...s, srs: SRSAlgorithm.reset(s.data.id, 'sentence') });
      setShowActionMenu(false);
      return;
    }
    // Reset only the current sense. Cards with the same spelling learn independently.
    if (!data.id) return;

    log('🔄 DetailView: Resetting SRS for item:', data.id, title);

    const targetTitle = (title || '').toLowerCase().trim();
    const targetSense = type === 'vocab' ? (data as VocabCard).sense || '' : '';
    const target = savedItemsRef.current.find(item => item.data.id === data.id) ??
      savedItemsRef.current.find(item =>
        !item.isDeleted &&
        item.type === type &&
        getItemTitle(item).toLowerCase().trim() === targetTitle &&
        (type !== 'vocab' || getItemSense(item) === targetSense)
      );

    if (target) {
      if (!onResetSRS?.(target.data.id)) onSave({ ...target, srs: SRSAlgorithm.reset(target.data.id, target.type) });
    } else {
      // The save list can lag briefly after opening a freshly generated result.
      onSave({
        data,
        type,
        savedAt: Date.now(),
        srs: SRSAlgorithm.reset(data.id, type),
      });
    }

    setShowActionMenu(false);
  }, [data, title, type, onSave, onResetSRS, isSentencePreview]);

  const handleRemember = useCallback(() => {
    // Ignore re-entry while a remember is mid-animation — a touch double-tap and the synthesized
    // dblclick can both land, and we must not advance/score the same sentence twice.
    if (rememberingRef.current) return;
    rememberingRef.current = true;
    if (isSentencePreview && !catalogSentencePreview && sentenceModeRef.current) {
      rememberingRef.current = false;
      return;
    }
    // Sentence mode: remember THIS sentence (its own SRS) and show the success overlay. The card STAYS
    // put afterwards — same as word-item review — so you can keep looking at it; switch sentences manually
    // (swipe ↑/↓, arrow keys, or the next-sentence gesture) when you're ready. The live SRS refresh means
    // the banner now reflects the bumped step/next-review in place.
    // The overlay shows the interval the review really schedules (FSRS handles a late review itself).
    const showRemembered = (next: SRSData, now: number) => {
      setRememberInfo({ intervalDays: Math.max(1, Math.round((next.nextReview - now) / 86400000)) });
      setShowSuccessAnim(true);
      if (successAnimTimerRef.current) clearTimeout(successAnimTimerRef.current);
      successAnimTimerRef.current = setTimeout(() => {
        setShowSuccessAnim(false);
        setRememberInfo(null);
        rememberingRef.current = false;
      }, 1500);
    };
    if (sentenceModeRef.current && currentSentenceRef.current) {
      const s = currentSentenceRef.current;
      const now = Date.now();
      const previewSRS = updateAfterRating(SRSAlgorithm.ensure(s.srs, s.data.id, 'sentence'), 'good', now);
      onUpdateSRS?.(
        s.data.id,
        'good',
        catalogSentencePreview ? { seedItem: s } : undefined,
      );
      showRemembered(previewSRS, now);
      return;
    }

    log('🧠 DetailView: Marking as remembered via shortcut/gesture');

    const targetTitle = (title || '').toLowerCase().trim();
    const saved = savedItemsRef.current.find(item => item.data.id === data.id) ??
      savedItemsRef.current.find(item =>
        !item.isDeleted && getItemTitle(item).toLowerCase().trim() === targetTitle &&
        getItemSense(item) === (type === 'vocab' ? (data as VocabCard).sense || '' : '')
      );

    const now = Date.now();
    if (saved) {
      // Compute preview SRS to show next review date in the animation
      const previewSRS = updateAfterRating(SRSAlgorithm.ensure(saved.srs, saved.data.id, saved.type), 'good', now);
      showRemembered(previewSRS, now);

      if (onUpdateSRS) {
        log('🧠 DetailView: applying FSRS review to this sense');
        onUpdateSRS(saved.data.id);
      } else {
        log('🧠 DetailView: Using onSave fallback for SRS update');
        onSave({ ...saved, srs: { ...previewSRS, id: saved.data.id } });
      }
    } else {
      // Create new item and immediately mark as remembered
      if (!data.id) { rememberingRef.current = false; return; }

      const newSRS = updateAfterRating(SRSAlgorithm.createNew(data.id, type), 'good', now);
      showRemembered(newSRS, now);

      onSave({
        data: data,
        type: type,
        savedAt: now,
        srs: newSRS
      });
    }
  }, [catalogSentencePreview, data, type, onSave, onUpdateSRS, title, onClose, isSentencePreview]);

  const handleDoubleClick = () => {
    // Avoid triggering when selecting text
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
       return;
    }

    log('👆👆 DetailView: Double click detected');
    cancelPendingSentenceSingleTap();
    handleRemember();
  };

  const handleSentenceSurfaceClick = (e: React.MouseEvent<HTMLElement>) => {
    if (Date.now() < suppressSentenceSurfaceClickUntilRef.current) return;
    if (window.getSelection()?.toString().trim()) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, [role="button"], input, textarea, select, label, [contenteditable="true"], [data-word-offset]')) return;
    queueSentenceSurfaceTap(e.clientX, e.clientY);
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (showActionMenu || detailInteractionLocked) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Typing or composing text isn't a shortcut, a dialog over the view (a confirm, the shortcut list, a
      // search result) has the keys to itself, and a held key acts once rather than deleting card after card.
      if (isTypingTarget(e.target) || isImeKey(e) || e.repeat || isDialogOpenOutside(rootRef.current)) return;

      // Cmd/Ctrl+1–4: Read the corresponding example sentence aloud (neural voice)
      if ((e.metaKey || e.ctrlKey) && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        speakSentenceAt(Number(e.key) - 1);
        return;
      }
      // The rest are bare keys, so Cmd+R still reloads rather than marking the card remembered.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // H: Toggle header visibility
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setShowHeader(prev => !prev);
      }

      // P: Pronounce the word (system voice)
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (title) speakWord(title);
      }

      // E: Read the example sentence(s) aloud (neural voice); press again to stop
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        readBothSentences();
      }

      // R: Remember (Shift+R: Reset)
      if (e.key === 'r' || e.key === 'R') {
         if (sentenceMode && isSentencePreview && !catalogSentencePreview) return;
         if (e.shiftKey) {
             if (isSentencePreview) return;
             e.preventDefault();
             handleResetSRS();
         } else {
             e.preventDefault();
             handleRemember();
         }
      }
      
      // S: Toggle save (word only; suppressed in sentence mode)
      if (e.key === 's' || e.key === 'S') {
        if (!sentenceMode) {
          e.preventDefault();
          handleToggleSave();
        }
      }

      // D: Delete directly (the sentence in sentence mode, else the saved word)
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        if (isSaved || (sentenceMode && !isSentencePreview)) handleDeleteItem();
      }

      // A: Archive / Unarchive (suppressed in sentence mode)
      if (e.key === 'a' || e.key === 'A') {
        if (!sentenceMode) {
          e.preventDefault();
          if (savedItemMatch?.isArchived) onUnarchive?.(savedItemMatch.data.id);
          else if (isSaved) handleArchiveItem();
        }
      }

      // Space: in sentence mode, pause/resume the sentence that's playing; if nothing is playing,
      // start/stop continuous auto-play. Elsewhere it stops whichever auto-play is running, or starts the
      // word-card slideshow — the two never run at once.
      if (e.key === ' ') {
        e.preventDefault();
        if (sentenceMode) {
          const st = getPlaybackState().status;
          if (st === 'playing') pauseCurrent();
          else if (st === 'paused') resumeCurrent();
          else if (!isSentenceAutoPlaying) toggleSentenceAutoPlay(); // only the visible Stop control exits autoplay
        } else if (isSentenceAutoPlaying) {
          toggleSentenceAutoPlay();
        } else {
          toggleAutoPlay();
        }
      }

      // +/=: Cycle speed forward
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        cycleSpeed();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [title, showActionMenu, detailInteractionLocked, handleRemember, handleResetSRS, handleToggleSave, isSaved, savedItemMatch, onUnarchive, cycleSpeed, readBothSentences, speakSentenceAt, sentenceMode, isSentencePreview, catalogSentencePreview, isSentenceAutoPlaying, toggleSentenceAutoPlay, toggleAutoPlay]);

  // Eyes-free read-zone band counts — how many of the two quarter-bands actually read something
  // (so the guides only draw the bands that do something). A phrase always has band 1 (the phrase
  // itself) and gets band 2 when a Key-Vocabulary example exists; a vocab card mirrors its example count.
  const wordZoneBands = (() => {
    if (sentenceMode || !currentItem) return 0;
    if (isPhraseItem(currentItem)) {
      const phrase = currentItem.data as SearchResult;
      const hasVocabEx = (phrase.vocabs || []).some(v => (v.examples || []).some(s => stripSentenceMarkers(s || '').trim()));
      return hasVocabEx ? 2 : 1;
    }
    return Math.min(2, examplesOf(currentItem).length);
  })();

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
      {/* Sentence-mode banner — the saved sentence's "card header": back, the sentence + natural-voice
          speaker, position, and the complete memorization/statistics row. Sits above the scroll area. */}
      {sentenceMode && currentSentence && (
        <div
          className={`bg-white border-b border-slate-200 px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 shadow-sm flex-1 flex flex-col min-h-0`}
          style={{ touchAction: 'manipulation' }}
          onTouchStart={onContentTouchStart}
          onTouchEnd={onContentTouchEnd}
          onClick={handleSentenceSurfaceClick}
          onDoubleClick={handleDoubleClick}
        >
          <div className={`mx-auto w-full ${hasSentenceImage ? 'max-w-3xl lg:max-w-6xl xl:max-w-[1400px]' : 'max-w-3xl'} flex-1 flex flex-col min-h-0`}>
            {/* Row 1: back + position */}
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <button
                onClick={requestSentenceExit}
                className={`flex items-center gap-1 text-sm font-medium -ml-1 -my-2 px-1 py-2.5 rounded-lg transition-colors ${
                  isSentenceAutoPlaying
                    ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                    : 'text-slate-600 hover:text-indigo-600 hover:bg-slate-100'
                }`}
                title={isSentenceAutoPlaying ? 'Auto-play is locked. Open its controls to stop.' : `Back to ${sentenceExitLabel} (Esc)`}
              >
                {isSentenceAutoPlaying ? <Lock size={16} /> : <ArrowLeft size={18} />}
                {isSentenceAutoPlaying ? 'Auto-play' : sentenceExitLabel}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setSentencePage('analysis'); }}
                  className="-my-1 flex h-9 w-9 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
                  title="Sentence analysis"
                  aria-label="Open sentence analysis"
                >
                  <BookOpenText size={15} />
                </button>
                {preparingSentenceId === currentSentenceSnapshot?.data.id && (
                  <span className="flex items-center gap-1 text-[10px] font-semibold text-indigo-500">
                    <Loader2 size={12} className="animate-spin" /> Loading lesson
                  </span>
                )}
                {!isMobile && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setTapToPlay(v => { const next = !v; try { localStorage.setItem('dictprop_sentence_tap_play', next ? '1' : '0'); } catch { /* ignore */ } return next; }); }}
                    className={`-my-1 flex items-center justify-center w-9 h-9 rounded-full transition-colors ${tapToPlay ? 'text-slate-400 hover:text-indigo-600 hover:bg-slate-100' : 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100'}`}
                    title={tapToPlay
                      ? 'Click a word = play from it. Click here to switch to look-up.'
                      : isMacDesktop
                        ? 'Click a word = look it up. Command-click always plays from that word.'
                        : 'Click any word = look it up. Click here to switch to play-from-word.'}
                  >
                    {tapToPlay ? <Volume2 size={15} /> : <SearchIcon size={15} />}
                  </button>
                )}
                <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full">
                  <MessageSquareQuote size={12} /> {sentenceIndex + 1} / {sentenceItems?.length ?? 0}
                </span>
                {!readOnlySentencePreview && sentenceDueCount > 0 && (
                  <span className="text-[11px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                    {sentenceDueCount} due
                  </span>
                )}
              </div>
            </div>

            {/* Row 2: the sentence — the hero, filling the page and centered in it. */}
            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col">
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
                          src={sentenceImageDirectSrc}
                          itemId={currentSentence.data.id}
                          alt="Attached image for this sentence"
                          onMissing={onLazyLoadImage}
                          className="w-full h-auto max-h-[32vh] md:max-h-[52vh] lg:max-h-[70vh] object-contain"
                          fallbackClassName="w-full aspect-[4/3]"
                        />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p
                        data-sentence-hero
                        className={`text-center md:text-left font-normal leading-relaxed tracking-tight text-slate-800 cursor-pointer select-text ${isCommandHeld ? 'sentence-command-seek-active' : ''} text-xl sm:text-3xl`}
                        onTouchStartCapture={isMobile ? handleMobileWordTouchStart : undefined}
                        onClickCapture={handleSentenceWordClickCapture}
                        title={isMobile
                          ? 'Tap a word to look it up'
                          : tapToPlay
                          ? 'Click a word to play from it · click blank space to play/pause · double-click blank space to remember'
                          : isMacDesktop
                            ? 'Click a word to look it up · Command-click to play from it · click blank space to play/pause'
                            : 'Click any word to look it up · click blank space to play/pause · double-click blank space to remember'}
                      >
                        <HighlightedSentence
                          text={currentSentenceText}
                          itemWord={(currentSentence.data as SentenceData).sourceWord}
                          findSaved={findSaved}
                          onOpenCard={onOpenCard}
                          {...(isMobile || !tapToPlay ? { onSearchWord: onSearch, searchAnyWord: true } : { onPlayFromWord: playFromWordOffset })}
                        />
                      </p>
                      <div className="mt-5 flex flex-wrap items-center justify-center md:justify-start gap-3">
                        <SentenceSpeakerButton
                          text={stripSentenceMarkers(currentSentenceText)}
                          onComplete={() => recordSentenceExposure(currentSentence.data.id)}
                        />
                        {copySentenceButton}
                        {commandClickHint}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* No image → the original centered full-width hero, unchanged. */
                  <>
                    <p
                      data-sentence-hero
                      className={`max-w-2xl mx-auto text-center font-normal leading-relaxed tracking-tight text-slate-800 cursor-pointer select-text ${isCommandHeld ? 'sentence-command-seek-active' : ''} text-2xl sm:text-4xl`}
                      onTouchStartCapture={isMobile ? handleMobileWordTouchStart : undefined}
                      onClickCapture={handleSentenceWordClickCapture}
                      title={isMobile
                        ? 'Tap a word to look it up'
                        : tapToPlay
                        ? 'Click a word to play from it · click blank space to play/pause · double-click blank space to remember'
                        : isMacDesktop
                          ? 'Click a word to look it up · Command-click to play from it · click blank space to play/pause'
                          : 'Click any word to look it up · click blank space to play/pause · double-click blank space to remember'}
                    >
                      <HighlightedSentence
                        text={currentSentenceText}
                        itemWord={(currentSentence.data as SentenceData).sourceWord}
                        findSaved={findSaved}
                        onOpenCard={onOpenCard}
                        {...(isMobile || !tapToPlay ? { onSearchWord: onSearch, searchAnyWord: true } : { onPlayFromWord: playFromWordOffset })}
                      />
                    </p>
                    <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                      <SentenceSpeakerButton
                        text={stripSentenceMarkers(currentSentenceText)}
                        onComplete={() => recordSentenceExposure(currentSentence.data.id)}
                      />
                      {copySentenceButton}
                      {commandClickHint}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* (Source-word card removed — the sentence stands alone; open any saved word via its footnote.) */}

            {/* Row 3: memorization stats + actions */}
            <div className="mt-2 flex items-center gap-2 text-xs">
              {sentenceMastery && sentenceMasteryColors && (
                <>
                  <span className={`${sentenceMasteryColors.bg} ${sentenceMasteryColors.text} px-2 py-0.5 rounded-full font-semibold whitespace-nowrap`}>
                    {sentenceMastery.label} {Math.round(sentenceMastery.percentage)}%
                  </span>
                  <div className="hidden sm:block flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className={`h-full ${sentenceMasteryColors.bar} transition-all duration-300`} style={{ width: `${sentenceMastery.percentage}%` }} />
                  </div>
                  <span className="text-slate-400 whitespace-nowrap">{currentSentence.srs?.totalReviews ?? 0}×</span>
                  {(currentSentence.srs?.correctStreak ?? 0) > 0 && (
                    <span className="text-orange-500 flex items-center gap-0.5"><Flame size={12} />{currentSentence.srs?.correctStreak}</span>
                  )}
                  <span className="text-emerald-600 flex items-center gap-0.5"><CheckCircle2 size={12} />{sentenceMemorizedCount}</span>
                  <span className="text-slate-500 whitespace-nowrap">
                    {(currentSentence.srs?.nextReview ?? 0) <= Date.now() ? 'due' : formatRelativeTime(currentSentence.srs?.nextReview ?? 0)}
                  </span>
                </>
              )}
              <div className="ml-auto flex items-center gap-1">
                {isSentencePreview ? (
                  catalogSentencePreview ? (
                    <button
                      type="button"
                      onClick={handleRemember}
                      className="flex min-h-11 items-center gap-2 rounded-md bg-emerald-500 px-4 text-sm font-bold text-white transition-colors hover:bg-emerald-600"
                      title={`Remember in this ${catalogPreviewKind === 'essay' ? 'essay' : 'Real Life collection'} (R)`}
                    >
                      <CheckCircle2 size={17} /> Got it
                    </button>
                  ) : onSaveSentence && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        const sentence = currentSentence.data as SentenceData;
                        onSaveSentence(sentence.text, sentence.sourceWord, sentence.sourceSense, sentence);
                      }}
                      className="flex min-h-11 items-center gap-2 rounded-md bg-indigo-600 px-4 text-sm font-bold text-white transition-colors hover:bg-indigo-700"
                      title="Save sentence for review"
                    >
                      <Bookmark size={17} /> Save sentence
                    </button>
                  )
                ) : (
                  <>
                    <button onClick={handleResetSRS} className="-my-1 flex h-9 w-9 items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors" title="Reset memory (Shift+R)" aria-label="Reset memory">
                      <RotateCcw size={15} />
                    </button>
                    <button onClick={handleDeleteItem} className="-my-1 flex h-9 w-9 items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="Delete sentence (D)" aria-label="Delete sentence">
                      <Trash2 size={15} />
                    </button>
                    <button onClick={handleRemember} className="-my-1 flex min-h-9 items-center gap-1 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-600 px-3 rounded-lg transition-colors" title="Remember (R)">
                      <CheckCircle2 size={14} /> Got it
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {sentenceMode && currentSentence && (
        <SentenceAnalysisView
          sentence={currentSentence.data as SentenceData}
          position={sentenceIndex + 1}
          total={sentenceItems?.length ?? 0}
          visible={sentencePage === 'analysis'}
          onBack={() => setSentencePage('sentence')}
          onSearch={(term) => { setSentencePage('sentence'); onSearch(term); }}
          onTouchStart={onContentTouchStart}
          onTouchEnd={onContentTouchEnd}
          onClick={handleSentenceSurfaceClick}
          onDoubleClick={handleDoubleClick}
        />
      )}
      {/* Word card — regular card mode only; in sentence review the sentence owns the page. */}
      {!sentenceMode && (
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
          <div className="sticky top-0 z-20 flex justify-center pt-2 pb-1">
            <div className="flex items-center gap-1">
              {currentGroup.items.map((_, idx) => (
                <div
                  key={idx}
                  className={`rounded-full transition-all duration-200 ${
                    idx === currentItemIndex 
                      ? 'w-1.5 h-1.5 bg-violet-400' 
                      : 'w-1 h-1 bg-slate-300'
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Header - combined with progress bar. Opens to its own height when the learner asks for it and
            closes at once, so a card change never slides the next card up after it appears. */}
        <div
          inert={!showHeader}
          className={`sticky top-0 z-30 grid ${showHeader ? 'grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out' : 'grid-rows-[0fr]'}`}
        >
          <div className={`min-h-0 overflow-hidden bg-white border-slate-200/60 ${showHeader ? 'border-b' : ''}`}>
            {/* Top row: navigation and actions */}
            <div className="px-4 py-2 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onClose} className="text-slate-600 -ml-2 hover:bg-slate-100/50">
                  <ArrowLeft size={20} className="mr-1" /> Close
                </Button>
                {/* Meaning position indicator - shows which card in the group */}
                {currentGroup && currentGroup.items.length > 1 && (
                  <span className="text-xs font-bold text-violet-600 bg-violet-50 px-2.5 py-1 rounded-full border border-violet-100">
                    {currentItemIndex + 1}/{currentGroup.items.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => {
                    const searchText = type === 'phrase' ? (data as SearchResult).query : (data as VocabCard).word;
                    // Use onRefresh if available (forces real AI search), otherwise fall back to onSearch
                    if (onRefresh) {
                      onRefresh(searchText);
                    } else {
                      onSearch(searchText);
                    }
                  }}
                  className="text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
                  title="Refresh with AI"
                >
                  <RefreshCw size={18} />
                </Button>
                {isSaved && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDeleteItem}
                    className="text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                    title="Delete (D)"
                  >
                    <Trash2 size={18} />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleToggleSave}
                  className={`px-3 gap-1.5 rounded-lg border ${isSaved ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'border-transparent text-slate-500 hover:bg-slate-100'}`}
                >
                  {isSaved ? <BookmarkMinus size={18} /> : <Bookmark size={18} />}
                  <span className="text-xs font-bold">{isSaved ? 'Saved' : 'Save'}</span>
                </Button>
                {/* Action menu for saved items */}
                {isSaved && (
                  <div ref={moreActionsRef} className="relative">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => setShowActionMenu(!showActionMenu)}
                      className="text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                      title="More actions"
                      aria-haspopup="menu"
                      aria-expanded={showActionMenu}
                    >
                      <MoreVertical size={18} />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          
            {/* Bottom row: Progress bar - shown for saved items (word mastery; sentence stats live in the banner) */}
            {isSaved && savedItemMatch && mastery && masteryColors && (
              <div className="px-4 pb-2">
                <div className="flex items-center gap-2 text-xs">
                  {/* Mastery badge with percentage */}
                  <span className={`${masteryColors.bg} ${masteryColors.text} px-2 py-0.5 rounded-full font-semibold`}>
                    {mastery.label} {Math.round(mastery.percentage)}%
                  </span>
                
                  {/* Progress bar */}
                  <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <div 
                      className={`h-full ${masteryColors.bar} transition-all duration-300`}
                      style={{ width: `${mastery.percentage}%` }}
                    />
                  </div>
                
                  {/* Stats */}
                  <span className="text-slate-400 whitespace-nowrap">
                    {savedItemMatch.srs?.totalReviews ?? 0}×
                  </span>
                  {(savedItemMatch.srs?.correctStreak ?? 0) > 0 && (
                    <span className="text-orange-500 flex items-center gap-0.5">
                      <Flame size={12} />
                      {savedItemMatch.srs?.correctStreak}
                    </span>
                  )}
                  {showHeader && <LibraryCounts savedItems={savedItems} />}
                  <span className="text-slate-300">•</span>
                  <span className="text-slate-500">
                    {(savedItemMatch.srs?.nextReview ?? 0) <= Date.now() ? 'due' : formatRelativeTime(savedItemMatch.srs?.nextReview ?? 0)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="p-4 pb-24 md:pb-8 md:px-6">

          {type === 'vocab' && (
            <ErrorBoundary variant="inline" fallbackMessage="This card couldn't be displayed.">
              <VocabCardDisplay
                data={data as VocabCard}
                isSaved={isSaved}
                onSave={handleToggleSave}
                showSave={false}
                onExpand={undefined}
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

          {/* Saved comparisons involving this word (+ any still generating in the background queue). */}
          {onOpenComparison && (wordComparisons.length > 0 || wordComparingPairs.length > 0) && (
            <div className="max-w-3xl md:max-w-5xl lg:max-w-6xl xl:max-w-[1400px] 2xl:max-w-[1600px] mx-auto mt-5">
              <div className="flex items-center gap-2 mb-2">
                <Scale size={14} className="text-indigo-500" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Comparisons</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {wordComparisons.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => onOpenComparison(c.words)}
                    className="px-3 py-1.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 transition-colors"
                    title="View this comparison"
                  >
                    {c.words.join(' vs ')}
                  </button>
                ))}
                {wordComparingPairs.map((k) => (
                  <span
                    key={k}
                    className="px-3 py-1.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200 flex items-center gap-1.5"
                    title="Generating in the background"
                  >
                    <Loader2 size={12} className="animate-spin" />
                    {k.split('|').join(' vs ')} · comparing…
                  </span>
                ))}
              </div>
            </div>
          )}

          {type === 'phrase' && (
            <div className="space-y-6 max-w-3xl md:max-w-5xl lg:max-w-6xl xl:max-w-[1400px] 2xl:max-w-[1600px] mx-auto">
              <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="md:flex">
                  {/* With a picture, a fixed height on phones so the text below doesn't move when it arrives. */}
                  <div className={`bg-slate-100 relative overflow-hidden flex items-center justify-center group md:w-2/5 md:shrink-0 ${(data as SearchResult).imageUrl ? 'h-48 md:h-auto' : ''}`}>
                    {(data as SearchResult).imageUrl ? (
                      <OfflineImage src={(data as SearchResult).imageUrl} itemId={(data as SearchResult).id} alt="Visual context" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" onMissing={onLazyLoadImage} />
                    ) : (
                      <div className="flex flex-col items-center text-slate-400 py-8">
                        <SearchIcon className="mb-2 opacity-30" size={32}/>
                        <span className="text-xs uppercase font-bold tracking-wider opacity-60">{(data as SearchResult).visualKeyword}</span>
                      </div>
                    )}
                  </div>

                <div className="p-6 sm:p-8 md:flex-1 md:min-w-0">
                  <div className="mb-6">
                    <h2 className="text-2xl xl:text-3xl font-bold text-slate-900 leading-tight mb-2">{(data as SearchResult).translation}</h2>
                    <p className="text-lg xl:text-xl text-slate-600 mb-3 leading-relaxed">{(data as SearchResult).query}</p>
                    <PronunciationBlock
                      text={(data as SearchResult).query}
                      ipa={(data as SearchResult).pronunciation}
                      className="text-base bg-slate-100 px-2 py-1 rounded-lg w-full"
                    />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <a
                        href={`https://www.playphrase.me/#/search?q=${encodeURIComponent((data as SearchResult).query)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.stopPropagation();
                          try { window.dispatchEvent(new Event('dictprop:before-external-nav')); } catch (_) {}
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 hover:bg-purple-100 hover:border-purple-300 transition-all active:scale-95 shadow-sm"
                        title="Hear in movie & TV clips on PlayPhrase.me"
                      >
                        <ExternalLink size={12} />
                        PlayPhrase
                      </a>
                      <a
                        href={buildChatGPTUrl((data as SearchResult).query)}
                        {...(!isMobile && { target: '_blank', rel: 'noopener noreferrer' })}
                        onClick={(e) => {
                          e.stopPropagation();
                          try { window.dispatchEvent(new Event('dictprop:before-external-nav')); } catch (_) {}
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 hover:bg-teal-100 hover:border-teal-300 transition-all active:scale-95 shadow-sm"
                        title="Ask ChatGPT (translator mode)"
                      >
                        <ExternalLink size={12} />
                        ChatGPT
                      </a>
                    </div>
                  </div>

                  <div className="prose prose-indigo prose-sm sm:prose-base xl:text-lg max-w-none text-slate-600">
                    <GrammarNotes markdown={(data as SearchResult).grammar} />
                  </div>
                </div>
              </div>{/* close md:flex */}
              </div>

              {((data as SearchResult).vocabs || []).length > 0 && (
                <div>
                  <div className="px-2 mb-4 flex items-center gap-2">
                    <SearchIcon size={16} className="text-indigo-500" />
                    <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Key Vocabulary</h3>
                  </div>
                  <div className="grid gap-4">
                    {((data as SearchResult).vocabs || []).map((vocab) => (
                      <ErrorBoundary key={vocab.id} variant="inline" fallbackMessage="This card couldn't be displayed.">
                        <div className="relative group/vocab">
                          {onRemoveVocabFromPhrase && (data as SearchResult).vocabs.length > 1 && (
                            <button
                              onClick={() => onRemoveVocabFromPhrase(data.id, vocab.id)}
                              className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full bg-slate-200 text-slate-500 hover:bg-rose-500 hover:text-white flex items-center justify-center opacity-0 group-hover/vocab:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-all duration-150 shadow-sm"
                              title="Remove this vocab"
                              aria-label={`Remove ${vocab.word} from this phrase`}
                            >
                              <X size={14} />
                            </button>
                          )}
                          <PhraseVocabCard
                            vocab={vocab}
                            onSaveVocab={handleSaveVocab}
                            isSaved={isVocabSaved(vocab)}
                            onSearch={onSearch}
                            scrollable={false}
                            showSave={true}
                            className="!h-auto !overflow-visible border-slate-200 shadow-sm hover:shadow-md transition-shadow"
                            onCompare={onCompare}
                            onSaveSentence={onSaveSentence}
                            onOpenExampleSentence={onOpenExampleSentence ? openExampleSentencePreview : undefined}
                            isSentenceSaved={isSentenceSaved}
                            onLazyLoadImage={onLazyLoadImage}
                          />
                        </div>
                      </ErrorBoundary>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
      </div>
      )}

      {/* Whole-session preload indicator (audio + images), bottom-left so it clears the autoplay cluster. */}
      <SessionPreload active={isSentenceAutoPlaying} getSession={getPreloadSession} onLazyLoadImage={onLazyLoadImage} />

      {/* Sentence playback controls. Keep speech style on the primary surface; only Auto-play-specific
          settings belong in the secondary panel. */}
      {sentenceMode ? (
        <div className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] right-4 z-[80] flex items-center gap-2">
          <SpeechStyleToggle
            className="shrink-0 bg-white shadow-lg border border-slate-200"
            onChange={rememberCurrentSentenceSpeechStyle}
          />
          <div className="relative shrink-0">
            {showSentenceAutoPlayPanel && (
              <div role="dialog" aria-label="Sentence auto-play settings" className="absolute bottom-14 right-0 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-700">Auto-play</span>
                  <button type="button" onClick={() => setShowSentenceAutoPlayPanel(false)} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-600" title="Close settings">
                    <X size={16} />
                  </button>
                </div>
                <div className="mb-3 flex justify-end">
                  <PlaybackSpeedToggle className="bg-slate-100" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <button type="button" onClick={cycleTimerDuration} className="min-w-0 rounded-lg bg-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-200" title="Auto-play duration">
                    <span className="block text-[10px] font-medium text-slate-400">Duration</span>
                    <AutoPlayCountdown startedAt={countdownStartedAt} minutes={autoPlayTimerMinutes} />
                  </button>
                  <button type="button" onClick={cycleRepeats} className="min-w-0 rounded-lg bg-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-200" title="Times each sentence is read">
                    <span className="block text-[10px] font-medium text-slate-400">Repeats</span>
                    ×{sentenceRepeats}
                  </button>
                  <button type="button" onClick={cycleGap} className="min-w-0 rounded-lg bg-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-200" title="Gap between reads">
                    <span className="block text-[10px] font-medium text-slate-400">Interval</span>
                    {sentenceGap / 1000}s
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => { setIsSentenceAutoPlaying(false); setShowSentenceAutoPlayPanel(false); }}
                  className="mt-3 w-full rounded-lg bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-100"
                >
                  Stop auto-play
                </button>
              </div>
            )}
            <button
              onClick={handleSentenceAutoPlayFab}
              className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
                isSentenceAutoPlaying
                  ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
              }`}
              title={isSentenceAutoPlaying ? 'Auto-play settings' : 'Start sentence auto-play'}
              aria-label={isSentenceAutoPlaying ? 'Open sentence auto-play settings' : 'Start sentence auto-play'}
            >
              <AudioLines size={20} />
            </button>
          </div>
        </div>
      ) : (
      <div className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] right-6 z-[60] flex items-center gap-2">
        {/* Clear ⇄ Casual speech style (global) — sits with the playback controls. */}
        <SpeechStyleToggle className="bg-white shadow-lg border border-slate-200" />
        {/* Voice speed (global): default 1.1×, up to 2×. Distinct from the "Speed per slide" pill below. */}
        <PlaybackSpeedToggle className="bg-white shadow-lg border border-slate-200" />
        <button
          onClick={cycleTimerDuration}
          className="bg-white text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
          title="Auto-play duration"
        >
          <AutoPlayCountdown startedAt={countdownStartedAt} minutes={autoPlayTimerMinutes} />
        </button>
        {isAutoPlaying && (
          <button
            onClick={cycleSpeed}
            className="bg-white text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
            title="Speed per slide"
          >
            {autoPlaySpeed / 1000}s
          </button>
        )}
        {isSentenceAutoPlaying && (
          <button
            onClick={cycleRepeats}
            className="bg-white text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
            title="Times each sentence is read"
          >
            ×{sentenceRepeats}
          </button>
        )}
        {isSentenceAutoPlaying && (
          <button
            onClick={cycleGap}
            className="bg-white text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
            title="Gap between reads"
          >
            {sentenceGap / 1000}s gap
          </button>
        )}
        <button
          onClick={toggleSentenceAutoPlay}
          className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
            isSentenceAutoPlaying
              ? 'bg-emerald-500 text-white hover:bg-emerald-600'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
          title={isSentenceAutoPlaying ? 'Stop auto-play (Space)' : 'Auto-play first sentence of each card'}
        >
          {isSentenceAutoPlaying ? <Pause size={20} /> : <AudioLines size={20} />}
        </button>
        <button
          onClick={toggleAutoPlay}
          className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
            isAutoPlaying
              ? 'bg-violet-500 text-white hover:bg-violet-600'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
          title={isAutoPlaying ? 'Pause (Space)' : 'Auto-play (Space)'}
        >
          {isAutoPlaying ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
        </button>
      </div>
      )}

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

      {/* Attach-image FAB (sentence mode only). Sits above the global AI-search FAB in the right rail
          (bottom-40 clears its bottom-24; z-[57] is above the search FAB's z-[55], below the autoplay
          cluster's z-[60]). Hidden while its own paste panel is open. */}
      {sentenceMode && currentSentence && !isSentencePreview && !showImagePanel && (
        <button
          onClick={handleImageFabTap}
          className="fixed bottom-40 right-4 z-[57] w-12 h-12 touch-manipulation rounded-full flex items-center justify-center shadow-lg bg-white text-slate-500 border border-slate-200 hover:text-indigo-600 hover:bg-slate-50 transition-all"
          aria-label={hasSentenceImage ? 'Replace image; double-tap to paste' : 'Attach image; double-tap to paste'}
          title={hasSentenceImage ? 'Replace image; double-tap to paste' : 'Attach image; double-tap to paste'}
        >
          {hasSentenceImage ? <ImageIcon size={20} /> : <ImagePlus size={20} />}
        </button>
      )}

      {/* Paste / drop / pick panel — mirrors the bottom-right AI-search input overlay. The card is
          focusable + data-image-panel so an in-panel ⌘V lands on onPaste (the window listener is the
          primary path). */}
      {sentenceMode && currentSentence && !isSentencePreview && showImagePanel && (
        <div className="fixed bottom-28 right-4 left-4 z-[58]">
          <div
            data-image-panel
            tabIndex={-1}
            onPaste={(e) => {
              const f = extractImageFromTransfer(e.clipboardData);
              if (f) { e.preventDefault(); void attachImageFromFile(f); }
            }}
            onDragOver={(e) => { e.preventDefault(); setImageDragOver(true); }}
            onDragLeave={() => setImageDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setImageDragOver(false);
              void attachImageFromFile(extractImageFromTransfer(e.dataTransfer));
            }}
            className={`bg-white rounded-2xl shadow-2xl border p-4 max-w-md ml-auto outline-none transition-colors ${imageDragOver ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-slate-200'}`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-700">
                {hasSentenceImage ? 'Replace image' : 'Attach image'}
              </span>
              <button onClick={() => setShowImagePanel(false)} className="text-slate-400 hover:text-slate-600" title="Close">
                <X size={18} />
              </button>
            </div>

            {imageUploading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-slate-500 text-sm">
                <Loader2 size={16} className="animate-spin text-indigo-500" /> Uploading…
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => imageFileInputRef.current?.click()}
                    className="min-h-20 border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center gap-1 text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                  >
                    <ImagePlus size={22} />
                    <span className="text-xs font-medium">Choose photo</span>
                  </button>
                  <div className="relative min-h-20 overflow-hidden border-2 border-dashed border-slate-200 rounded-xl text-slate-500 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 transition-colors">
                    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1">
                      <ClipboardPaste size={22} />
                      <span className="text-xs font-medium">Paste image</span>
                      <span className="text-[11px] text-slate-400">Long press</span>
                    </div>
                    <div
                      contentEditable
                      suppressContentEditableWarning
                      role="textbox"
                      aria-label="Paste an image"
                      inputMode="none"
                      onPaste={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.replaceChildren();
                        const file = extractImageFromTransfer(e.clipboardData);
                        if (file) void attachImageFromFile(file);
                        else setImageError('The clipboard does not contain an image.');
                      }}
                      onInput={(e) => e.currentTarget.replaceChildren()}
                      className="relative z-10 min-h-20 w-full cursor-text select-text text-transparent caret-transparent outline-none"
                    />
                  </div>
                </div>
                <input
                  ref={imageFileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; void attachImageFromFile(f); }}
                />
              </>
            )}
            {imageError && <p className="mt-2 text-xs text-rose-500">{imageError}</p>}
          </div>
        </div>
      )}

      {exampleSentencePreview && previewSentence && (
        <ErrorBoundary
          onReset={() => { exampleSentenceRequestRef.current += 1; setExampleSentencePreview(null); }}
          fallbackMessage="Something went wrong displaying this sentence. Your word card is still open."
        >
          <DetailView
            key={`example-sentence:${previewSentence.data.id}`}
            groups={[exampleSentencePreview.sourceGroup]}
            initialGroupIndex={0}
            initialItemIndex={0}
            sentenceItems={[previewSentence]}
            onClose={() => { exampleSentenceRequestRef.current += 1; setExampleSentencePreview(null); }}
            onSave={onSave}
            onDelete={(id) => { onDelete(id); exampleSentenceRequestRef.current += 1; setExampleSentencePreview(null); }}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            savedItems={savedItems}
            savedSentenceItems={savedSentenceItems}
            onSearch={onSearch}
            onRefresh={onRefresh}
            onLazyLoadImage={onLazyLoadImage}
            onUpdateSRS={onUpdateSRS}
            onCompare={onCompare}
            comparisons={comparisons}
            comparingKeys={comparingKeys}
            onOpenComparison={onOpenComparison}
            onSaveSentence={onSaveSentence}
            isSentenceSaved={isSentenceSaved}
            isVocabSaved={isVocabSaved}
            onRemoveVocabFromPhrase={onRemoveVocabFromPhrase}
            findSaved={findSaved}
            onOpenCard={onOpenCard}
            interactionLocked={interactionLocked}
            sentencePreviewOnly={!savedPreviewSentence}
            onAttachImage={onAttachImage}
          />
        </ErrorBoundary>
      )}

    </div>
  );
};
