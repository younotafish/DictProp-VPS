import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { VocabCard, SearchResult, StoredItem, SentenceData, getItemTitle, getItemSpelling, getItemSense, getItemImageUrl, ItemGroup, isPhraseItem, StoredComparison, type ReviewRating } from '../types';
import { ArrowLeft, Bookmark, BookmarkMinus, Search as SearchIcon, RefreshCw, Trash2, Archive, MoreVertical, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, RotateCcw, Sparkles, Flame, CheckCircle2, Clock, X, Play, Pause, AudioLines, Volume2, ExternalLink, MessageSquareQuote, Loader2, Scale, ImagePlus, Image as ImageIcon, Copy, Check, ClipboardPaste, BookOpenText, Lock } from 'lucide-react';
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
import { getMasteryColors } from '../components/mastery';
import ReactMarkdown from 'react-markdown';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { useKeyboardNavigation, useWheelNavigation } from '../hooks';
import { speakNatural, speakWord, prefetchTTS, preloadAudio, getPlaybackState, getPlaybackProgress, pauseCurrent, resumeCurrent, stopCurrent, seekCurrent, getTimingsFor, ensureTimings, setMediaMetadata, setMediaSessionHandlers, primeKeepAlive, acquireKeepAlive, releaseKeepAlive, afterGap, type SpeakHandle } from '../services/lazyTts';
import { alignWordsToStripped, seekTimeForOffset } from '../services/ttsAlignment';
import { loadImage } from '../services/storage';
import { log, warn, error as logError } from '../services/logger';
import { isRealLifeProgressItem } from '../services/realLifeProgress';

// Helper to format relative time for next review
const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = timestamp - now;

  if (diff <= 0) return 'now';

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
};

// Format interval days for the "Remembered!" overlay
const formatNextReview = (days: number): string => {
  if (days <= 1) return 'tomorrow';
  if (days <= 30) return `in ${days} days`;
  const months = Math.round(days / 30 * 2) / 2; // Round to nearest 0.5
  if (months <= 1) return 'in ~1 month';
  return `in ~${months % 1 === 0 ? months.toFixed(0) : months.toFixed(1)} months`;
};

// Read a Blob/File as a base64 data URI (for pasted/picked/dropped sentence images).
const fileToDataUri = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// Pull the first image out of a clipboard/drop transfer. Safari may expose pasted photos through
// either `items` or `files`, depending on the iOS/iPadOS version and source app.
const extractImageFromTransfer = (transfer: DataTransfer | null | undefined): File | null => {
  for (const it of Array.from(transfer?.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  for (const file of Array.from(transfer?.files ?? [])) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
};

const readImageFromSystemClipboard = async (): Promise<Blob | null> => {
  if (!navigator.clipboard?.read) return null;
  const clipboardItems = await navigator.clipboard.read();
  for (const item of clipboardItems) {
    const imageType = item.types.find(type => type.startsWith('image/'));
    if (imageType) return item.getType(imageType);
  }
  return null;
};

// Copy text to the clipboard. Prefers the async Clipboard API (needs HTTPS — dictprop.online is);
// falls back to a hidden-textarea execCommand for older/unsupported contexts. Returns success.
const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

const normalizeSentenceIdentity = (text: string): string =>
  stripSentenceMarkers(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();


interface DetailViewProps {
  groups?: ItemGroup[];
  initialGroupIndex?: number;
  initialItemIndex?: number;
  
  onClose: () => void;
  onSave: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
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

export const DetailView: React.FC<DetailViewProps> = ({
  groups,
  initialGroupIndex = 0,
  initialItemIndex = 0,
  onClose, 
  onSave, 
  onDelete,
  onArchive,
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

  // State for 2D navigation
  const [currentGroupIndex, setCurrentGroupIndex] = useState(initialGroupIndex);
  const [currentItemIndex, setCurrentItemIndex] = useState(initialItemIndex);
  
  const [isAnimating, setIsAnimating] = useState(false);
  const [showHeader, setShowHeader] = useState(false); // Hidden by default, shown on short swipe down or H key
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [sentencePage, setSentencePage] = useState<'sentence' | 'analysis'>('sentence');
  const [exampleSentencePreview, setExampleSentencePreview] = useState<{
    sentence: StoredItem;
    sourceGroup: ItemGroup;
  } | null>(null);
  const exampleSentenceRequestRef = useRef(0);
  const detailInteractionLocked = interactionLocked || !!exampleSentencePreview;
  const cardCollapsed = true; // sentence review: the sentence is always the full-page focus (the source-word card was removed — open any saved word via its footnote)
  // Sentence review — what tapping a word does. true (default) = play from that word (current behaviour);
  // false = look up the dotted [[uncommon]] term via the bottom-right search, like every other view. Persisted.
  const [tapToPlay, setTapToPlay] = useState(() => {
    try { return localStorage.getItem('dictprop_sentence_tap_play') !== '0'; } catch { return true; }
  });
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [autoPlaySpeed, setAutoPlaySpeed] = useState(2000); // ms
  const [autoPlayTimerMinutes, setAutoPlayTimerMinutes] = useState(20);
  const [autoPlayStartedAt, setAutoPlayStartedAt] = useState<number | null>(null);
  const [, setAutoPlayNowTick] = useState(0);
  const [isSentenceAutoPlaying, setIsSentenceAutoPlaying] = useState(false);
  const isSentenceAutoPlayingRef = useRef(isSentenceAutoPlaying);
  useEffect(() => { isSentenceAutoPlayingRef.current = isSentenceAutoPlaying; }, [isSentenceAutoPlaying]);
  const [showSentenceAutoPlayPanel, setShowSentenceAutoPlayPanel] = useState(false);
  const [sentenceGap, setSentenceGap] = useState(2000); // ms of silence between every read (repeats + distinct sentences)
  const [sentenceRepeats, setSentenceRepeats] = useState(3); // times each sentence is read (total), 1–5
  // Whole-session preload progress (audio clips + images), null when idle/done. See the preload effect below.
  const [preloadProgress, setPreloadProgress] = useState<{ done: number; total: number } | null>(null);
  const sessionPreloadStartedRef = useRef(false);
  const [showSuccessAnim, setShowSuccessAnim] = useState(false);
  const [rememberInfo, setRememberInfo] = useState<{
    intervalDays: number;
    penalty?: number;
    daysOverdue?: number;
    intervalWithout?: number; // what the interval would have been without penalty
  } | null>(null);
  const lastScrollY = useRef(0);

  // Keep a ref to savedItems so callbacks always see fresh data without re-creating
  const savedItemsRef = useRef(savedItems);
  useEffect(() => { savedItemsRef.current = savedItems; }, [savedItems]);
  const savedSentenceItemsRef = useRef(savedSentenceItems);
  useEffect(() => { savedSentenceItemsRef.current = savedSentenceItems; }, [savedSentenceItems]);

  // Set indices only on initial mount — after that, DetailView owns navigation
  // and the runtime clamping (lines below) handles out-of-bounds after deletion
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (groups && !hasInitialized.current) {
      hasInitialized.current = true;
      setCurrentGroupIndex(Math.min(initialGroupIndex, groups.length - 1));
      const group = groups[Math.min(initialGroupIndex, groups.length - 1)];
      setCurrentItemIndex(group ? Math.min(initialItemIndex, group.items.length - 1) : 0);
    }
  }, [groups, initialGroupIndex, initialItemIndex]);
  
  // Determine current item to display
  let currentItem: StoredItem | null = null;
  let currentGroup: ItemGroup | null = null;
  let hasNextGroup = false;
  let hasPrevGroup = false;
  let hasNextItem = false;
  let hasPrevItem = false;

  if (groups && groups.length > 0) {
    // Safety: clamp indices to valid range
    const safeGroupIndex = Math.min(currentGroupIndex, groups.length - 1);
    currentGroup = groups[safeGroupIndex];
    
    if (currentGroup && currentGroup.items.length > 0) {
      const safeItemIndex = Math.min(currentItemIndex, currentGroup.items.length - 1);
      currentItem = currentGroup.items[safeItemIndex];
      
      hasNextGroup = safeGroupIndex < groups.length - 1;
      hasPrevGroup = safeGroupIndex > 0;
      hasNextItem = safeItemIndex < currentGroup.items.length - 1;
      hasPrevItem = safeItemIndex > 0;
    }
  }
  
  // Reset item index when user navigates to a different group (not on groups rebuild)
  const prevGroupIndexRef = useRef(currentGroupIndex);
  useEffect(() => {
    if (prevGroupIndexRef.current !== currentGroupIndex) {
      prevGroupIndexRef.current = currentGroupIndex;
      // Keep the analysis page open while moving between saved sentences. Word review still resets to
      // its primary page when changing groups.
      if (sentenceItems?.length) {
        const analysisScroller = document.querySelector<HTMLElement>('[data-sentence-analysis]');
        if (analysisScroller) analysisScroller.scrollTop = 0;
      } else {
        setSentencePage('sentence');
      }
      setCurrentItemIndex(0);
    }
  }, [currentGroupIndex, sentenceItems]);

  // Lazy-load the image from the server if it is missing locally.
  useEffect(() => {
    if (!currentItem || !onLazyLoadImage) return;
    
    const itemId = currentItem.data.id;
    const imageUrl = getItemImageUrl(currentItem);
    
    // Check if this item is saved and missing an image
    const isSaved = savedItemsRef.current.some(i => i.data.id === itemId);
    const hasImage = imageUrl && (imageUrl.startsWith('data:image/') || imageUrl === 'idb:stored' || imageUrl.startsWith('server:has_image'));

    if (isSaved && !hasImage) {
      // Trigger the server-backed lazy load.
      onLazyLoadImage(itemId);
    }
  }, [currentItem?.data.id, onLazyLoadImage]);


  if (!currentItem) {
    return null;
  }
  
  const data = currentItem.data;
  const type = currentItem.type;

  const openExampleSentencePreview = (text: string, word: string, sense?: string) => {
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
  };

  const savedPreviewSentence = exampleSentencePreview
    ? savedSentenceItems.find(item => item.type === 'sentence' && !isRealLifeProgressItem(item) && (
      item.data.id === exampleSentencePreview.sentence.data.id ||
      normalizeSentenceIdentity((item.data as SentenceData).text) ===
        normalizeSentenceIdentity((exampleSentencePreview.sentence.data as SentenceData).text)
    ))
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
  const [preparedSentenceById, setPreparedSentenceById] = useState<Record<string, StoredItem>>({});
  const [preparingSentenceId, setPreparingSentenceId] = useState<string | null>(null);
  const preparationRequestsRef = useRef(new Set<string>());
  const unavailableSentenceIdsRef = useRef(new Set<string>());
  const preparedSentenceSnapshot = currentSentenceSnapshot
    ? (preparedSentenceById[currentSentenceSnapshot.data.id] ?? currentSentenceSnapshot)
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
        ? savedSentenceItems.find(item => item.type === 'sentence' && !item.isDeleted &&
            normalizeSentenceIdentity((item.data as SentenceData).text) ===
            normalizeSentenceIdentity(currentSentenceData?.text ?? ''))
        : undefined
    : undefined;
  const readOnlySentencePreview = sentencePreviewOnly || (catalogSentencePreview && !savedCurrentSentence);
  const currentSentence = savedCurrentSentence && preparedSentenceSnapshot
    ? {
        ...savedCurrentSentence,
        data: {
          ...(preparedSentenceSnapshot.data as SentenceData),
          ...(savedCurrentSentence.data as SentenceData),
          analysis: (preparedSentenceSnapshot.data as SentenceData).analysis ??
            (savedCurrentSentence.data as SentenceData).analysis,
          imageUrl: (savedCurrentSentence.data as SentenceData).imageUrl ??
            (preparedSentenceSnapshot.data as SentenceData).imageUrl,
        },
      }
    : preparedSentenceSnapshot;
  const isSentencePreview = !savedCurrentSentence && !!currentSentenceSnapshot &&
    (readOnlySentencePreview || currentSentenceSnapshot.data.id.startsWith('sentence-preview:'));
  const currentSentenceText = currentSentence ? (currentSentence.data as SentenceData).text : '';
  const sentenceExitLabel = catalogSentencePreview
    ? 'Real Life'
    : isSentencePreview
      ? 'Word'
      : 'Sentences';

  useEffect(() => {
    if (!catalogSentencePreview || !currentSentenceSnapshot) return;
    const id = currentSentenceSnapshot.data.id;
    const sourceSentence = currentSentenceSnapshot.data as SentenceData;
    if (!sourceSentence.catalogSentenceId || unavailableSentenceIdsRef.current.has(id)) return;
    const prepared = preparedSentenceById[id];
    if ((prepared?.data as SentenceData | undefined)?.analysis || preparationRequestsRef.current.has(id)) return;
    preparationRequestsRef.current.add(id);
    setPreparingSentenceId(id);
    void import('../services/sentenceEnrichment').then(({ default: loadPreparedSentenceEnrichment }) =>
      loadPreparedSentenceEnrichment(sourceSentence.text)
    ).then(result => {
      if (!result) {
        unavailableSentenceIdsRef.current.add(id);
        return;
      }
      const preparedItem: StoredItem = {
        ...currentSentenceSnapshot,
        data: {
          ...sourceSentence,
          analysis: result.analysis,
          analysisGeneratedAt: result.analysisGeneratedAt,
          ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
        },
      };
      setPreparedSentenceById(current => ({ ...current, [id]: preparedItem }));

      const savedMatch = savedSentenceItemsRef.current.find(candidate =>
        candidate.type === 'sentence' && !candidate.isDeleted && (
          candidate.data.id === id ||
          ((candidate.data as SentenceData).catalogSentenceId === sourceSentence.catalogSentenceId &&
            (candidate.data as SentenceData).catalogCollectionId === sourceSentence.catalogCollectionId)
        )
      );
      if (savedMatch) {
        const savedData = savedMatch.data as SentenceData;
        onSave({
          ...savedMatch,
          data: {
            ...savedData,
            catalogSentenceId: sourceSentence.catalogSentenceId,
            catalogCollectionId: sourceSentence.catalogCollectionId,
            analysis: result.analysis,
            analysisGeneratedAt: result.analysisGeneratedAt,
            imageUrl: savedData.imageUrl ?? result.imageUrl,
          },
        });
      }
    }).catch(error => {
      warn('Failed to load prepared Real Life sentence', error);
    }).finally(() => {
      preparationRequestsRef.current.delete(id);
      setPreparingSentenceId(current => current === id ? null : current);
    });
  }, [catalogSentencePreview, currentSentenceSnapshot, onSave, preparedSentenceById]);

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
  const [sentenceCopied, setSentenceCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);
  const handleCopySentence = useCallback(async () => {
    const s = currentSentenceRef.current;                 // read via ref → never a stale sentence
    const text = s ? stripSentenceMarkers((s.data as SentenceData).text || '').trim() : '';
    if (!text) return;
    if (!(await copyTextToClipboard(text))) return;
    setSentenceCopied(true);                               // flip icon → green check as confirmation
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setSentenceCopied(false), 1600);
  }, []);

  // Small copy button that sits beside the sentence's speaker button (same compact icon style). Rendered
  // in exactly one hero branch at a time (the image / no-image ternary), so reusing the element is safe.
  const copySentenceButton = (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void handleCopySentence(); }}
      className={`p-0.5 transition-colors ${sentenceCopied ? 'text-emerald-500' : 'text-indigo-300 hover:text-indigo-600'}`}
      title={sentenceCopied ? 'Copied — paste it into Meta AI' : 'Copy sentence (to paste into Meta AI)'}
    >
      {sentenceCopied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );

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
    if (touchStartX.current === null || touchStartY.current === null || isAnimating) return;
    
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
      // A still tap inside the expanded word card is handled by its onClick (eyes-free zone read),
      // so the sentence play/pause/remember below ignores it — avoids a touch + synthesized-click double-fire.
      if (isStillTap && !onControl && !onSentenceWord && !tapTarget?.closest('[data-word-card-scroll]')) {
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
        setIsAnimating(true);
        setCurrentGroupIndex(prev => prev + 1);
        setCurrentItemIndex(0); // Reset to first meaning
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
        setTimeout(() => setIsAnimating(false), 300);
      }
      // Swipe DOWN -> Previous Group (Word) - only when at top
      else if (diffY > longSwipeMin && hasPrevGroup && isAtTop) {
        setIsAutoPlaying(false);
        setShowHeader(false); // Hide header on navigation
        setIsAnimating(true);
        setCurrentGroupIndex(prev => prev - 1);
        setCurrentItemIndex(0); // Reset to first meaning
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
        setTimeout(() => setIsAnimating(false), 300);
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
          setIsAnimating(true);
          setCurrentItemIndex(prev => (prev + 1) % totalItems);
          setTimeout(() => setIsAnimating(false), 300);
        }
      }
      
      // Swipe RIGHT -> Prev Item (Meaning) or Close
      if (diffX > horizontalSwipeMin) {
        setIsAutoPlaying(false);
        if (hasPrevItem) {
          setShowHeader(false); // Hide header on navigation
          setIsAnimating(true);
          setCurrentItemIndex(prev => prev - 1);
          setTimeout(() => setIsAnimating(false), 300);
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

  // Warm the TTS cache for the visible card's example SENTENCES (the word itself uses the system
  // voice) so sentence taps/auto-play are instant and play through the iOS-unlocked <audio> element.
  useEffect(() => {
    const card = type === 'vocab' ? (data as VocabCard) : null;
    const sentences = (card?.examples || []).filter(Boolean) as string[];
    if (sentences.length) prefetchTTS(sentences);
  }, [currentGroupIndex, currentItemIndex, type, data]);

  // In sentence review, warm the CURRENT sentence's audio + word timings so a double-click / Enter seek
  // is reliable. ensureTimings also kicks off background generation if this sentence has no timings yet
  // (whisper cold-start is ~a minute) so they're ready by the time the user goes to seek.
  useEffect(() => {
    if (sentenceMode && currentSentenceText) {
      prefetchTTS([currentSentenceText]);
      ensureTimings(currentSentenceText);
    }
  }, [sentenceMode, currentSentenceText]);

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

  // Calculate global stats for saved items (memoized to avoid O(n) scans on every render)
  const { memorizedCount, dueToday } = useMemo(() => {
    const activeItems = savedItems.filter(i => !i.isDeleted && !i.isArchived);
    const memorized = activeItems.filter(i => (i.srs?.memoryStrength ?? 0) >= 70).length;
    const dueSpellings = new Set<string>();
    const now = Date.now();
    activeItems.forEach(i => {
      if ((i.srs?.nextReview ?? 0) <= now) {
        const spelling = (i.type === 'phrase' ? (i.data as any).query : (i.data as any).word || '').toLowerCase().trim();
        if (spelling) dueSpellings.add(spelling);
      }
    });
    return { memorizedCount: memorized, dueToday: dueSpellings.size };
  }, [savedItems]);
  
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

  // Navigation handlers for keyboard
  const handlePrevItem = useCallback(() => {
    if (hasPrevItem && !isAnimating) {
      setIsAutoPlaying(false);
      setIsAnimating(true);
      setCurrentItemIndex(prev => prev - 1);
      setTimeout(() => setIsAnimating(false), 300);
    }
  }, [hasPrevItem, isAnimating]);

  const handleNextItem = useCallback(() => {
    const totalItems = currentGroup ? currentGroup.items.length : 0;
    if (totalItems >= 1 && !isAnimating) {
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
        setIsAnimating(true);
        setCurrentItemIndex(prev => (prev + 1) % totalItems);
        setTimeout(() => setIsAnimating(false), 300);
      }
    }
  }, [currentGroup, isAnimating, currentItem]);

  const handlePrevGroup = useCallback(() => {
    if (hasPrevGroup && !isAnimating && groups) {
      setIsAutoPlaying(false);
      setIsAnimating(true);
      setCurrentGroupIndex(prev => prev - 1);
      setCurrentItemIndex(0);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      setTimeout(() => setIsAnimating(false), 300);
    }
  }, [hasPrevGroup, isAnimating, groups]);

  const handleNextGroup = useCallback(() => {
    if (hasNextGroup && !isAnimating && groups) {
      setIsAutoPlaying(false);
      setIsAnimating(true);
      setCurrentGroupIndex(prev => prev + 1);
      setCurrentItemIndex(0);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      setTimeout(() => setIsAnimating(false), 300);
    }
  }, [hasNextGroup, isAnimating, groups]);

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
  useEffect(() => { setGroupPlayCount(1); }, [currentGroupIndex, isAutoPlaying]);

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
        setIsAnimating(true);
        setCurrentItemIndex(prev => prev + 1);
        setGroupPlayCount(prev => prev + 1);
        setTimeout(() => setIsAnimating(false), 300);
      } else if (needsRepeat) {
        // Single-meaning word: replay it once with a fade and re-pronounce
        setIsAnimating(true);
        setGroupPlayCount(prev => prev + 1);
        if (title) speakWord(title);
        setTimeout(() => setIsAnimating(false), 300);
      } else if (!isLastGroup) {
        // Advance to next group (word)
        setIsAnimating(true);
        setCurrentGroupIndex(prev => prev + 1);
        setCurrentItemIndex(0);
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
        setTimeout(() => setIsAnimating(false), 300);
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

  // Once auto-play is requested, preload the WHOLE session so a poor/unstable network can't interrupt
  // review: warm every example/saved sentence's audio + timings, and pull every card's image into IDB.
  // Best-effort and cancellable; per-item failures still advance the progress so it always completes.
  useEffect(() => {
    if (!isSentenceAutoPlaying) {
      setPreloadProgress(null);
      sessionPreloadStartedRef.current = false;
      return;
    }
    if (sessionPreloadStartedRef.current) return;
    sessionPreloadStartedRef.current = true;
    let cancelled = false;

    // Audio: saved sentences in sentence mode, else every card's example sentences across the session.
    const texts = sentenceMode
      ? (sentenceItems ?? []).map(s => (s.data as SentenceData).text || '')
      : (groups ?? []).flatMap(g => g.items.flatMap(it => examplesOf(it)));
    // Images: the displayed word/phrase cards (in sentence mode these are the sentences' source cards).
    const ids = Array.from(new Set((groups ?? []).flatMap(g => g.items.map(it => it.data.id))));

    const audioTotal = Array.from(new Set(texts.map(t => stripSentenceMarkers(t || '').trim()).filter(Boolean))).length;
    const imageTotal = onLazyLoadImage ? ids.length : 0;
    const grandTotal = audioTotal + imageTotal;
    if (grandTotal === 0) return;

    let audioDone = 0;
    let imageDone = 0;
    const report = () => {
      if (cancelled) return;
      const done = audioDone + imageDone;
      setPreloadProgress(done >= grandTotal ? null : { done, total: grandTotal });
    };
    report();

    // Audio — one progress-reporting batch (de-dupes + generates missing internally).
    preloadAudio(texts, (d) => { audioDone = d; report(); }).catch(() => {});

    // Images — bounded concurrency; skip any already in IDB so repeat sessions don't re-download.
    (async () => {
      if (!onLazyLoadImage || ids.length === 0) return;
      const CONCURRENCY = 4;
      let i = 0;
      const worker = async () => {
        while (i < ids.length && !cancelled) {
          const id = ids[i++];
          try {
            const cached = await loadImage(id);
            if (!cached && !cancelled) await onLazyLoadImage(id);
          } catch { /* best-effort */ }
          imageDone++;
          report();
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    })();

    return () => {
      cancelled = true;
      // A quick stop may cancel the workers before the session is warm. Allow the next start to resume.
      sessionPreloadStartedRef.current = false;
    };
    // Deliberately begins only when auto-play is requested; normal sentence opening stays render-first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSentenceAutoPlaying]);

  const sentenceGapRef = useRef(sentenceGap);
  useEffect(() => { sentenceGapRef.current = sentenceGap; }, [sentenceGap]);
  const sentenceRepeatsRef = useRef(sentenceRepeats);
  useEffect(() => { sentenceRepeatsRef.current = sentenceRepeats; }, [sentenceRepeats]);

  const recordSentenceAutoplayExposure = useCallback(() => {
    const sentence = currentSentenceRef.current;
    if (!sentence) return;
    const now = Date.now();
    const baseSrs = SRSAlgorithm.ensure(sentence.srs, sentence.data.id, 'sentence');
    const updated: StoredItem = {
      ...sentence,
      srs: SRSAlgorithm.updateAfterExposure(baseSrs, 0.25, now),
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
        setIsAnimating(true);
        setCurrentItemIndex(p => p + 1);
        setTimeout(() => setIsAnimating(false), 300);
      } else if (!isLastGroup) {
        setIsAnimating(true);
        setCurrentGroupIndex(p => p + 1);
        setCurrentItemIndex(0);
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
        setTimeout(() => setIsAnimating(false), 300);
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
        if (sentenceModeRef.current && completesSuccessfulRound) recordSentenceAutoplayExposure();
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

  // Tick once a second while playing, and stop auto-play when the timer expires
  useEffect(() => {
    if ((!isAutoPlaying && !isSentenceAutoPlaying) || autoPlayStartedAt === null) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - autoPlayStartedAt;
      if (elapsed >= autoPlayTimerMinutes * 60 * 1000) {
        setIsAutoPlaying(false);
        setIsSentenceAutoPlaying(false);
      } else {
        setAutoPlayNowTick(t => t + 1);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isAutoPlaying, isSentenceAutoPlaying, autoPlayStartedAt, autoPlayTimerMinutes]);

  const timerDisplay = (() => {
    if ((!isAutoPlaying && !isSentenceAutoPlaying) || autoPlayStartedAt === null) {
      return `${autoPlayTimerMinutes}m`;
    }
    const remainingMs = Math.max(0, autoPlayStartedAt + autoPlayTimerMinutes * 60_000 - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    const mm = Math.floor(remainingSec / 60);
    const ss = remainingSec % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  })();

  // Fresh ref to the on-screen card so the keyboard readers below read current data without re-subscribing.
  const currentItemRef = useRef(currentItem);
  useEffect(() => { currentItemRef.current = currentItem; });

  // ── Manual sentence reading — all speech funnels through the shared playback state (neuralTts), so
  // the megaphone icons stay in sync and a second press can pause / resume / restart what's playing. ──

  // E: read the displayed card's example sentences in turn (or, in sentence mode, the saved sentence).
  // Press again to pause; once more to resume.
  const readBothSentences = useCallback(() => {
    let sentences: string[];
    if (sentenceModeRef.current && currentSentenceRef.current) {
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
        onEnd: () => setTimeout(playNext, 400),   // small breath between the two sentences
        onError: () => setTimeout(playNext, 400),
      });
    };
    playNext();
  }, []);

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
    speakNatural(sentence, { allowDownload: true });
  }, []);

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
    speakNatural(sentence, { allowDownload: true });
  }, []);

  // Play the current sentence starting at a clicked/selected word (by its char offset in the stripped
  // sentence). If this sentence's clip is already the active audio, seek it in place (seamless);
  // otherwise (re)start the sentence and seek once it's playing. Falls back to whole-sentence playback
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
      return;
    }
    if (isSentenceAutoPlayingRef.current) return;
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    speakNatural(stripped, { allowDownload: true, startAt: startAt ?? undefined }); // (re)start AT the word
  }, []);

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
    setIsAnimating(true);
    setCurrentGroupIndex(clamped);
    setCurrentItemIndex(0);
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    const analysisScroller = document.querySelector<HTMLElement>('[data-sentence-analysis]');
    if (analysisScroller) analysisScroller.scrollTop = 0;
    setTimeout(() => setIsAnimating(false), 300);
    const next = list[clamped];
    const sentence = next ? stripSentenceMarkers((next.data as SentenceData).text || '').trim() : '';
    // The autoplay effect restarts itself at the selected sentence after the index changes. Starting a
    // separate manual clip here would supersede that chain and leave autoplay visually on but stalled.
    if (!keepAutoPlaying && sentence) speakNatural(sentence, { allowDownload: true });
  }, [speakCurrentSentence]);

  // Arrow keys / trackpad wheel: sentence mode uses ←/→ for its two pages and ↑/↓ for
  // sentence navigation. Page changes deliberately leave the shared speech session untouched.
  const navLeft = useCallback(() => { if (sentenceModeRef.current) setSentencePage('sentence'); else handlePrevItem(); }, [handlePrevItem]);
  const navRight = useCallback(() => { if (sentenceModeRef.current) setSentencePage('analysis'); else handleNextItem(); }, [handleNextItem]);
  const navUp = useCallback(() => { if (sentenceModeRef.current) goToSentence(currentGroupIndexRef.current - 1); else handlePrevGroup(); }, [handlePrevGroup, goToSentence]);
  const navDown = useCallback(() => { if (sentenceModeRef.current) goToSentence(currentGroupIndexRef.current + 1); else handleNextGroup(); }, [handleNextGroup, goToSentence]);

  const requestSentenceExit = useCallback(() => {
    if (isSentenceAutoPlaying) {
      setShowSentenceAutoPlayPanel(true);
      return;
    }
    onClose();
  }, [isSentenceAutoPlaying, onClose]);

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
      setIsAnimating(true);
      setCurrentGroupIndex(nextIdx);
      setCurrentItemIndex(0);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      setTimeout(() => setIsAnimating(false), 300);
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

  // Keyboard navigation
  useKeyboardNavigation({
    onEscape: sentencePage === 'analysis' ? () => setSentencePage('sentence') : requestSentenceExit,
    onArrowLeft: navLeft,
    onArrowRight: navRight,
    onArrowUp: navUp,
    onArrowDown: navDown,
    onEnter: handleEnterFromSelection,
    onSave: handleToggleSave,
    enabled: !showActionMenu && !detailInteractionLocked,
  });

  // Trackpad wheel navigation
  useWheelNavigation({
    onScrollLeft: navLeft,
    onScrollRight: navRight,
    containerRef: scrollContainerRef,
    threshold: 80,
    enabled: !detailInteractionLocked && !!(currentGroup && currentGroup.items.length >= 1),
  });

  const handleVocabSearch = (term: string) => {
    onSearch(term);
  };

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

  const handleSaveVocab = (vocab: VocabCard) => {
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

  const handleResetSRS = useCallback(() => {
    // Sentence mode: reset just this sentence's SRS.
    if (sentenceModeRef.current && currentSentenceRef.current) {
      if (isSentencePreview) return;
      const s = currentSentenceRef.current;
      log('🔄 DetailView: Resetting SRS for sentence:', s.data.id);
      onSave({ ...s, srs: SRSAlgorithm.createNew(s.data.id, 'sentence') });
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
      onSave({
        ...target,
        srs: SRSAlgorithm.createNew(target.data.id, target.type),
      });
    } else {
      // The save list can lag briefly after opening a freshly generated result.
      onSave({
        data,
        type,
        savedAt: Date.now(),
        srs: SRSAlgorithm.createNew(data.id, type),
      });
    }

    setShowActionMenu(false);
  }, [data, title, type, onSave, isSentencePreview]);

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
    if (sentenceModeRef.current && currentSentenceRef.current) {
      const s = currentSentenceRef.current;
      const baseSRS = SRSAlgorithm.ensure(s.srs, s.data.id, 'sentence');
      const previewSRS = SRSAlgorithm.updateAfterRemember(baseSRS);
      const penalty = SRSAlgorithm.getOverduePenalty(baseSRS);
      const daysOverdue = Math.max(0, Math.round((Date.now() - baseSRS.nextReview) / 86400000));
      const schedule = SRSAlgorithm.getSchedule();
      const noPenaltyStep = Math.min(baseSRS.totalReviews + 1, schedule.length);
      const intervalWithout = schedule[Math.max(0, Math.min(noPenaltyStep - 1, schedule.length - 1))];
      setRememberInfo({ intervalDays: Math.round(previewSRS.stability), penalty, daysOverdue, intervalWithout });
      onUpdateSRS?.(
        s.data.id,
        'good',
        catalogSentencePreview ? { seedItem: s } : undefined,
      );
      setShowSuccessAnim(true);
      setTimeout(() => {
        setShowSuccessAnim(false);
        setRememberInfo(null);
        rememberingRef.current = false;
      }, 1500);
      return;
    }

    log('🧠 DetailView: Marking as remembered via shortcut/gesture');

    const targetTitle = (title || '').toLowerCase().trim();
    const saved = savedItemsRef.current.find(item => item.data.id === data.id) ??
      savedItemsRef.current.find(item =>
        !item.isDeleted && getItemTitle(item).toLowerCase().trim() === targetTitle &&
        getItemSense(item) === (type === 'vocab' ? (data as VocabCard).sense || '' : '')
      );

    if (saved) {
      // Compute preview SRS to show next review date in the animation
      const baseSRS = SRSAlgorithm.ensure(saved.srs, saved.data.id, saved.type);
      const previewSRS = SRSAlgorithm.updateAfterRemember(baseSRS);
      const penalty = SRSAlgorithm.getOverduePenalty(baseSRS);
      const daysOverdue = Math.max(0, Math.round((Date.now() - baseSRS.nextReview) / 86400000));
      // Compute what the interval would have been without penalty
      const schedule = SRSAlgorithm.getSchedule();
      const noPenaltyStep = Math.min(baseSRS.totalReviews + 1, schedule.length);
      const intervalWithout = schedule[Math.max(0, Math.min(noPenaltyStep - 1, schedule.length - 1))];
      setRememberInfo({
        intervalDays: Math.round(previewSRS.stability),
        penalty,
        daysOverdue,
        intervalWithout,
      });

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

      let newSRS = SRSAlgorithm.createNew(data.id, type);
      newSRS = SRSAlgorithm.updateAfterRemember(newSRS);
      setRememberInfo({ intervalDays: Math.round(newSRS.stability) });

      onSave({
        data: data,
        type: type,
        savedAt: Date.now(),
        srs: newSRS
      });
    }

    // Trigger Success Animation (after computing info so it's available for display)
    setShowSuccessAnim(true);
    setTimeout(() => {
      setShowSuccessAnim(false);
      setRememberInfo(null);
      rememberingRef.current = false;
    }, 1500);
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

  // Eyes-free zone read on the EXPANDED word card during sentence review: a click/tap in the card's top
  // quarter plays the source word's 1st example sentence, the second quarter plays the 2nd; the bottom
  // half is inert. Zones are measured against the card element (not the viewport) so they line up below
  // the sentence banner. One onClick path serves desktop clicks AND mobile taps (synthesized click), so
  // the touch handler bows out for still taps inside this card (see onContentTouchEnd) to avoid a
  // double-fire. Mirrors the standalone word card's eyes-free zones and routes through toggleSpeak so a
  // second tap on the same zone pauses/resumes the shared playback.
  const handleWordCardZoneRead = (e: React.MouseEvent<HTMLElement>) => {
    if (window.getSelection()?.toString().trim()) return; // don't hijack a text selection
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, [role="button"], input, textarea, select, label')) return; // a control
    const ex = examplesOf(currentItem);
    if (!ex.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientY - rect.top;
    const zone = rel < rect.height / 4 ? 0 : rel < rect.height / 2 ? 1 : -1; // top ¼ → 1st, 2nd ¼ → 2nd
    if (zone < 0) return;
    flashZone(zone);
    toggleSpeak(ex[Math.min(zone, ex.length - 1)]);
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (showActionMenu || detailInteractionLocked) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if in input
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

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
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          readBothSentences();
        }
      }

      // Cmd/Ctrl+1–4: Read the corresponding example sentence aloud (neural voice)
      if ((e.metaKey || e.ctrlKey) && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        speakSentenceAt(Number(e.key) - 1);
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
        if (!e.metaKey && !e.ctrlKey && !sentenceMode) { // Don't interfere with Cmd+S
          e.preventDefault();
          handleToggleSave();
        }
      }

      // D: Delete directly (the sentence in sentence mode, else the saved word)
      if (e.key === 'd' || e.key === 'D') {
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          if (isSaved || (sentenceMode && !isSentencePreview)) handleDeleteItem();
        }
      }

      // A: Archive / Unarchive (suppressed in sentence mode)
      if (e.key === 'a' || e.key === 'A') {
        if (!e.metaKey && !e.ctrlKey && !sentenceMode) {
          e.preventDefault();
          if (isSaved) handleArchiveItem();
        }
      }

      // Space: in sentence mode, pause/resume the sentence that's playing; if nothing is playing,
      // start/stop continuous auto-play. Elsewhere it toggles the word-card auto-play slideshow.
      if (e.key === ' ') {
        e.preventDefault();
        if (sentenceMode) {
          const st = getPlaybackState().status;
          if (st === 'playing') pauseCurrent();
          else if (st === 'paused') resumeCurrent();
          else if (!isSentenceAutoPlaying) toggleSentenceAutoPlay(); // only the visible Stop control exits autoplay
        } else {
          setIsAutoPlaying(prev => !prev);
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
  }, [title, showActionMenu, detailInteractionLocked, handleRemember, handleResetSRS, handleToggleSave, isSaved, cycleSpeed, readBothSentences, speakSentenceAt, sentenceMode, isSentencePreview, catalogSentencePreview, isSentenceAutoPlaying, toggleSentenceAutoPlay]);

  // Eyes-free read-zone band counts — how many of the two quarter-bands actually read something
  // (so the guides only draw the bands that do something). Word view: a phrase always has band 1
  // (the phrase itself) and gets band 2 when a Key-Vocabulary example exists; a vocab card mirrors
  // its example count. Sentence-review word card: the source word's example count.
  const wordZoneBands = (() => {
    if (sentenceMode || !currentItem) return 0;
    if (isPhraseItem(currentItem)) {
      const phrase = currentItem.data as SearchResult;
      const hasVocabEx = (phrase.vocabs || []).some(v => (v.examples || []).some(s => stripSentenceMarkers(s || '').trim()));
      return hasVocabEx ? 2 : 1;
    }
    return Math.min(2, examplesOf(currentItem).length);
  })();
  const cardZoneBands = sentenceMode ? Math.min(2, examplesOf(currentItem).length) : 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-50 flex flex-col animate-in slide-in-from-right duration-300 shadow-2xl"
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
          className={`bg-white border-b border-slate-200 px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 shadow-sm ${cardCollapsed ? 'flex-1 flex flex-col min-h-0' : 'shrink-0'}`}
          style={{ touchAction: 'manipulation' }}
          onTouchStart={onContentTouchStart}
          onTouchEnd={onContentTouchEnd}
          onClick={handleSentenceSurfaceClick}
          onDoubleClick={handleDoubleClick}
        >
          <div className={`mx-auto w-full ${hasSentenceImage ? 'max-w-3xl lg:max-w-6xl xl:max-w-[1400px]' : 'max-w-3xl'} ${cardCollapsed ? 'flex-1 flex flex-col min-h-0' : ''}`}>
            {/* Row 1: back + position */}
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <button
                onClick={requestSentenceExit}
                className={`flex items-center gap-1 text-sm font-medium -ml-1 px-1 py-0.5 rounded-lg transition-colors ${
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
                  className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
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
                    className={`flex items-center justify-center w-7 h-7 rounded-full transition-colors ${tapToPlay ? 'text-slate-400 hover:text-indigo-600 hover:bg-slate-100' : 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100'}`}
                    title={tapToPlay ? 'Tap a word = play from it. Tap here to switch to look-up.' : 'Tap any word = look it up (saved words open their card). Tap here to switch to play-from-word.'}
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

            {/* Row 2: the sentence — the hero. Fills + vertically centers the page when the card is
                collapsed; compact when the card is expanded. */}
            <div className={cardCollapsed ? 'flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col' : 'py-3'}>
              <div className={cardCollapsed ? 'my-auto w-full py-4' : ''}>
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
                          className="w-full h-auto max-h-[32vh] md:max-h-[52vh] lg:max-h-[70vh] object-contain fade-in"
                          fallbackClassName="w-full aspect-[4/3]"
                        />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p
                        data-sentence-hero
                        className={`text-center md:text-left font-normal leading-relaxed tracking-tight text-slate-800 cursor-pointer select-text ${cardCollapsed ? 'text-xl sm:text-3xl' : 'text-lg sm:text-xl'}`}
                        onTouchStartCapture={isMobile ? handleMobileWordTouchStart : undefined}
                        onClickCapture={isMobile ? suppressMobileChordClick : undefined}
                        title={isMobile
                          ? 'Tap a word to look it up'
                          : tapToPlay
                          ? 'Tap a word to play from it · tap blank space to play/pause · double-tap blank space to remember'
                          : 'Tap any word to look it up (saved words open their card) · tap blank space to play/pause · double-tap blank space to remember'}
                      >
                        <HighlightedSentence
                          text={currentSentenceText}
                          itemWord={(currentSentence.data as SentenceData).sourceWord}
                          findSaved={findSaved}
                          onOpenCard={onOpenCard}
                          {...(isMobile || !tapToPlay ? { onSearchWord: handleVocabSearch, searchAnyWord: true } : { onPlayFromWord: playFromWordOffset })}
                        />
                      </p>
                      <div className="mt-5 flex items-center justify-center md:justify-start gap-3">
                        <SentenceSpeakerButton text={stripSentenceMarkers(currentSentenceText)} />
                        {copySentenceButton}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* No image → the original centered full-width hero, unchanged. */
                  <>
                    <p
                      data-sentence-hero
                      className={`max-w-2xl mx-auto text-center font-normal leading-relaxed tracking-tight text-slate-800 cursor-pointer select-text ${cardCollapsed ? 'text-2xl sm:text-4xl' : 'text-lg sm:text-xl'}`}
                      onTouchStartCapture={isMobile ? handleMobileWordTouchStart : undefined}
                      onClickCapture={isMobile ? suppressMobileChordClick : undefined}
                      title={isMobile
                        ? 'Tap a word to look it up'
                        : tapToPlay
                        ? 'Tap a word to play from it · tap blank space to play/pause · double-tap blank space to remember'
                        : 'Tap any word to look it up (saved words open their card) · tap blank space to play/pause · double-tap blank space to remember'}
                    >
                      <HighlightedSentence
                        text={currentSentenceText}
                        itemWord={(currentSentence.data as SentenceData).sourceWord}
                        findSaved={findSaved}
                        onOpenCard={onOpenCard}
                        {...(isMobile || !tapToPlay ? { onSearchWord: handleVocabSearch, searchAnyWord: true } : { onPlayFromWord: playFromWordOffset })}
                      />
                    </p>
                    <div className="mt-5 flex items-center justify-center gap-3">
                      <SentenceSpeakerButton text={stripSentenceMarkers(currentSentenceText)} />
                      {copySentenceButton}
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
                      title="Remember in this Real Life collection (R)"
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
                    <button onClick={handleResetSRS} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors" title="Reset memory (Shift+R)">
                      <RotateCcw size={15} />
                    </button>
                    <button onClick={handleDeleteItem} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="Delete sentence (D)">
                      <Trash2 size={15} />
                    </button>
                    <button onClick={handleRemember} className="flex items-center gap-1 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 rounded-lg transition-colors" title="Remember (R)">
                      <CheckCircle2 size={14} /> Got it
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {sentenceMode && currentSentence && sentencePage === 'analysis' && (
        <SentenceAnalysisView
          sentence={currentSentence.data as SentenceData}
          position={sentenceIndex + 1}
          total={sentenceItems?.length ?? 0}
          onBack={() => setSentencePage('sentence')}
          onSearch={(term) => { setSentencePage('sentence'); handleVocabSearch(term); }}
          onTouchStart={onContentTouchStart}
          onTouchEnd={onContentTouchEnd}
          onClick={handleSentenceSurfaceClick}
          onDoubleClick={handleDoubleClick}
        />
      )}
      {/* Word card — the supporting source-word detail. Hidden in sentence review when collapsed
          (so the sentence owns the page); always shown in regular card mode. */}
      {!sentenceMode && (
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollContainerRef}
        data-word-card-scroll
        className={`flex-1 min-h-0 overflow-y-auto no-scrollbar transition-opacity duration-300 ${isAnimating ? 'opacity-50' : 'opacity-100'}`}
        style={{ touchAction: 'pan-y pinch-zoom' }}
        onScroll={handleScroll}
        onTouchStart={onContentTouchStart}
        onTouchEnd={onContentTouchEnd}
        onClick={sentenceMode ? handleWordCardZoneRead : undefined}
        onDoubleClick={sentenceMode ? undefined : handleDoubleClick}
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

        {/* Header - combined with progress bar */}
        <div className={`sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-200/60 shrink-0 transition-all duration-300 overflow-hidden ${showHeader ? 'max-h-32 opacity-100' : 'max-h-0 opacity-0 border-b-0'}`}>
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
              {!sentenceMode && isSaved && (
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
              {!sentenceMode && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggleSave}
                className={`px-3 gap-1.5 rounded-lg border ${isSaved ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'border-transparent text-slate-500 hover:bg-slate-100'}`}
              >
                {isSaved ? <BookmarkMinus size={18} /> : <Bookmark size={18} />}
                <span className="text-xs font-bold">{isSaved ? 'Saved' : 'Save'}</span>
              </Button>
              )}
              {/* Action menu for saved items */}
              {!sentenceMode && isSaved && (
                <div className="relative">
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={() => setShowActionMenu(!showActionMenu)}
                    className="text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                    title="More actions"
                  >
                    <MoreVertical size={18} />
                  </Button>
                </div>
              )}
            </div>
          </div>
          
          {/* Bottom row: Progress bar - shown for saved items (word mastery; sentence stats live in the banner) */}
          {!sentenceMode && isSaved && savedItemMatch && mastery && masteryColors && (
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
                <span className="text-slate-300">•</span>
                <span className="text-emerald-600 flex items-center gap-0.5">
                  <CheckCircle2 size={12} />
                  {memorizedCount}
                </span>
                <span className="text-slate-300">•</span>
                <span className="text-amber-600 flex items-center gap-0.5">
                  <Clock size={12} />
                  {dueToday}
                </span>
                <span className="text-slate-300">•</span>
                <span className="text-slate-500">
                  {(savedItemMatch.srs?.nextReview ?? 0) <= Date.now() ? 'due' : formatRelativeTime(savedItemMatch.srs?.nextReview ?? 0)}
                </span>
              </div>
            </div>
          )}
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
                onSearch={handleVocabSearch}
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
                  <div className="bg-slate-100 relative overflow-hidden flex items-center justify-center group max-h-48 md:max-h-none md:w-2/5 md:shrink-0">
                    {(data as SearchResult).imageUrl ? (
                      <OfflineImage src={(data as SearchResult).imageUrl} itemId={(data as SearchResult).id} alt="Visual context" className="w-full h-full object-cover fade-in transition-transform duration-700 group-hover:scale-105" onMissing={onLazyLoadImage} />
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
                    <ReactMarkdown
                      components={{
                        strong: (props) => <span className="font-bold text-indigo-700 bg-indigo-50 px-1 rounded" {...props} />
                      }}
                    >
                      {(data as SearchResult).grammar}
                    </ReactMarkdown>
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
                              className="absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full bg-slate-200 text-slate-500 hover:bg-rose-500 hover:text-white flex items-center justify-center opacity-0 group-hover/vocab:opacity-100 transition-all duration-150 shadow-sm"
                              title="Remove this vocab"
                            >
                              <X size={14} />
                            </button>
                          )}
                          <VocabCardDisplay
                            data={vocab}
                            onSave={() => handleSaveVocab(vocab)}
                            isSaved={savedItems.some(i => getItemSpelling(i) === (vocab.word || '').toLowerCase().trim() && getItemSense(i) === vocab.sense)}
                            onSearch={handleVocabSearch}
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

          {/* Desktop navigation buttons — hidden; use keyboard arrows instead */}
          <div className="hidden fixed bottom-6 left-1/2 -translate-x-1/2 z-40 items-center gap-2 bg-white/90 backdrop-blur-sm rounded-full px-4 py-2 shadow-lg border border-slate-200">
            {/* Previous word */}
            {hasPrevGroup && (
              <button
                onClick={handlePrevGroup}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-700 flex items-center gap-1"
                title="Previous word (↑)"
              >
                <ChevronUp size={16} />
                <span className="text-xs font-medium">Prev word</span>
              </button>
            )}
            
            {/* Previous meaning */}
            {hasPrevItem && (
              <button
                onClick={handlePrevItem}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-700 flex items-center gap-1"
                title="Previous meaning (←)"
              >
                <ChevronLeft size={16} />
                <span className="text-xs font-medium">Prev</span>
              </button>
            )}
            
            {/* Position indicator */}
            {currentGroup && currentGroup.items.length > 1 && (
              <span className="text-xs font-bold text-violet-600 bg-violet-50 px-3 py-1 rounded-full">
                {currentItemIndex + 1}/{currentGroup.items.length}
              </span>
            )}
            
            {/* Next meaning - always available for looping (even with 1 item) */}
            {currentGroup && currentGroup.items.length >= 1 && (
              <button
                onClick={handleNextItem}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-700 flex items-center gap-1"
                title="Next meaning (→)"
              >
                <span className="text-xs font-medium">Next</span>
                <ChevronRight size={16} />
              </button>
            )}
            
            {/* Next word */}
            {hasNextGroup && (
              <button
                onClick={handleNextGroup}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-700 flex items-center gap-1"
                title="Next word (↓)"
              >
                <span className="text-xs font-medium">Next word</span>
                <ChevronDown size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      {/* Eyes-free read-zone guides for the sentence-review word card (card-anchored, click + tap). */}
      {cardZoneBands > 0 && (
        <EyesFreeZones anchor="fill" bands={cardZoneBands} flash={zoneFlash} />
      )}
      </div>
      )}

      {/* Whole-session preload indicator (audio + images), bottom-left so it clears the autoplay cluster. */}
      {preloadProgress && (
        <div className="fixed bottom-6 left-6 z-[60] flex items-center gap-2 bg-white/90 backdrop-blur-sm text-slate-600 text-xs font-medium px-3 py-2 rounded-full shadow-lg border border-slate-200 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <Loader2 size={14} className="animate-spin text-indigo-500" />
          <span>Preloading {preloadProgress.done}/{preloadProgress.total}</span>
        </div>
      )}

      {/* Sentence playback controls. Keep speech style on the primary surface; only Auto-play-specific
          settings belong in the secondary panel. */}
      {sentenceMode ? (
        <div className="fixed bottom-6 right-4 z-[80] flex items-center gap-2">
          <SpeechStyleToggle className="shrink-0 bg-white/90 backdrop-blur-sm shadow-lg border border-slate-200" />
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
                    {timerDisplay}
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
                  : 'bg-white/90 backdrop-blur-sm text-slate-600 border border-slate-200 hover:bg-slate-50'
              }`}
              title={isSentenceAutoPlaying ? 'Auto-play settings' : 'Start sentence auto-play'}
              aria-label={isSentenceAutoPlaying ? 'Open sentence auto-play settings' : 'Start sentence auto-play'}
            >
              <AudioLines size={20} />
            </button>
          </div>
        </div>
      ) : (
      <div className="fixed bottom-6 right-6 z-[60] flex items-center gap-2">
        {/* Clear ⇄ Casual speech style (global) — sits with the playback controls. */}
        <SpeechStyleToggle className="bg-white/90 backdrop-blur-sm shadow-lg border border-slate-200" />
        {/* Voice speed (global): default 1.1×, up to 2×. Distinct from the "Speed per slide" pill below. */}
        <PlaybackSpeedToggle className="bg-white/90 backdrop-blur-sm shadow-lg border border-slate-200" />
        <button
          onClick={cycleTimerDuration}
          className="bg-white/90 backdrop-blur-sm text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
          title="Auto-play duration"
        >
          {timerDisplay}
        </button>
        {isAutoPlaying && (
          <button
            onClick={cycleSpeed}
            className="bg-white/90 backdrop-blur-sm text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
            title="Speed per slide"
          >
            {autoPlaySpeed / 1000}s
          </button>
        )}
        {isSentenceAutoPlaying && (
          <button
            onClick={cycleRepeats}
            className="bg-white/90 backdrop-blur-sm text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
            title="Times each sentence is read"
          >
            ×{sentenceRepeats}
          </button>
        )}
        {isSentenceAutoPlaying && (
          <button
            onClick={cycleGap}
            className="bg-white/90 backdrop-blur-sm text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
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
              : 'bg-white/90 backdrop-blur-sm text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
          title={isSentenceAutoPlaying ? 'Stop auto-play (Space)' : (sentenceMode ? 'Auto-play saved sentences · natural voice (Space)' : 'Auto-play first sentence of each card')}
        >
          {isSentenceAutoPlaying ? <Pause size={20} /> : <AudioLines size={20} />}
        </button>
        {!sentenceMode && (
        <button
          onClick={toggleAutoPlay}
          className={`w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
            isAutoPlaying
              ? 'bg-violet-500 text-white hover:bg-violet-600'
              : 'bg-white/90 backdrop-blur-sm text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
          title={isAutoPlaying ? 'Pause (Space)' : 'Auto-play (Space)'}
        >
          {isAutoPlaying ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
        </button>
        )}
      </div>
      )}

      {/* Success Animation Overlay */}
      {showSuccessAnim && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center pointer-events-none">
          <div className="bg-white/90 backdrop-blur-md px-6 py-4 rounded-2xl shadow-2xl flex flex-col items-center gap-1 animate-in zoom-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex items-center gap-3">
              <Sparkles className="text-amber-500 w-6 h-6 animate-pulse" />
              <span className="text-slate-800 font-bold text-lg">Remembered!</span>
            </div>
            {rememberInfo && (
              rememberInfo.penalty && rememberInfo.penalty > 0 && rememberInfo.intervalWithout ? (
                <span className="text-sm text-slate-500">
                  Next review {formatNextReview(rememberInfo.intervalDays)}{' '}
                  <span className="text-amber-600">(not {formatNextReview(rememberInfo.intervalWithout).replace('in ', '')} — {rememberInfo.daysOverdue}d late)</span>
                </span>
              ) : (
                <span className="text-sm text-slate-500">
                  Next review {formatNextReview(rememberInfo.intervalDays)}
                </span>
              )
            )}
          </div>
        </div>
      )}

      {/* Action menu dropdown - positioned fixed to escape overflow */}
      {showActionMenu && (
        <>
          <div 
            className="fixed inset-0 z-[55]" 
            onClick={() => setShowActionMenu(false)}
          />
          <div className="fixed right-4 top-12 z-[56] bg-white rounded-xl shadow-xl border border-slate-200 py-1 min-w-[180px] animate-in fade-in zoom-in-95 duration-150">
            {onArchive && (
              <button
                onClick={handleArchiveItem}
                className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-amber-50 hover:text-amber-700 flex items-center gap-2.5 transition-colors"
              >
                <Archive size={16} />
                Archive
              </button>
            )}
            <button
              onClick={handleResetSRS}
              className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 flex items-center gap-2.5 transition-colors"
            >
              <RotateCcw size={16} />
              Reset Memory Strength
            </button>
            <button
              onClick={handleDeleteItem}
              className="w-full px-4 py-2.5 text-left text-sm text-rose-600 hover:bg-rose-50 flex items-center gap-2.5 transition-colors"
            >
              <Trash2 size={16} />
              Delete
            </button>
          </div>
        </>
      )}

      {/* Attach-image FAB (sentence mode only). Sits above the global AI-search FAB in the right rail
          (bottom-40 clears its bottom-24; z-[57] is above the search FAB's z-[55], below the autoplay
          cluster's z-[60]). Hidden while its own paste panel is open. */}
      {sentenceMode && currentSentence && !isSentencePreview && !showImagePanel && (
        <button
          onClick={handleImageFabTap}
          className="fixed bottom-40 right-4 z-[57] w-12 h-12 touch-manipulation rounded-full flex items-center justify-center shadow-lg bg-white/90 backdrop-blur-sm text-slate-500 border border-slate-200 hover:text-indigo-600 hover:bg-slate-50 transition-all"
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
        <div className="fixed bottom-28 right-4 left-4 z-[58] animate-in slide-in-from-bottom-2 duration-200">
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
