import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { VocabCard, SearchResult, StoredItem, SentenceData, getItemTitle, getItemSpelling, getItemSense, getItemImageUrl, ItemGroup, isPhraseItem } from '../types';
import { ArrowLeft, Bookmark, BookmarkMinus, Search as SearchIcon, RefreshCw, Trash2, Archive, MoreVertical, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, RotateCcw, Sparkles, Flame, CheckCircle2, Clock, X, Play, Pause, AudioLines, ExternalLink, MessageSquareQuote } from 'lucide-react';
import { Button } from '../components/Button';
import { VocabCardDisplay, buildChatGPTUrl } from '../components/VocabCard';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { OfflineImage } from '../components/OfflineImage';
import { HighlightedSentence, stripSentenceMarkers } from '../components/HighlightedSentence';
import { SentenceSpeakerButton } from '../components/SentenceSpeakerButton';
import ReactMarkdown from 'react-markdown';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { useKeyboardNavigation, useWheelNavigation } from '../hooks';
import { speakNatural, speakWord, prefetchTTS, getPlaybackState, getPlaybackProgress, pauseCurrent, resumeCurrent, stopCurrent, seekCurrent, getTimingsFor, ensureTimings, type SpeakHandle } from '../services/neuralTts';
import { alignWordsToStripped, seekTimeForOffset } from '../services/ttsAlignment';
import { log, warn } from '../services/logger';

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

// Color classes for mastery levels
const getMasteryColors = (color: string) => {
  const colorMap: Record<string, { bg: string; text: string; bar: string }> = {
    slate: { bg: 'bg-slate-100', text: 'text-slate-600', bar: 'bg-slate-400' },
    orange: { bg: 'bg-orange-100', text: 'text-orange-600', bar: 'bg-orange-400' },
    amber: { bg: 'bg-amber-100', text: 'text-amber-600', bar: 'bg-amber-400' },
    blue: { bg: 'bg-blue-100', text: 'text-blue-600', bar: 'bg-blue-400' },
    emerald: { bg: 'bg-emerald-100', text: 'text-emerald-600', bar: 'bg-emerald-400' },
    purple: { bg: 'bg-purple-100', text: 'text-purple-600', bar: 'bg-purple-400' },
  };
  return colorMap[color] || colorMap.slate;
};

interface DetailViewProps {
  groups?: ItemGroup[];
  initialGroupIndex?: number;
  initialItemIndex?: number;
  
  onClose: () => void;
  onSave: (item: StoredItem) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
  savedItems: StoredItem[];
  onSearch: (text: string) => void;
  onRefresh?: (text: string) => void; // Force a real AI search, bypassing local cache
  onLazyLoadImage?: (itemId: string) => Promise<string | null>; // Fetch image from server if missing locally
  onUpdateSRS?: (itemId: string) => void; // Direct SRS update (triggers "remember")
  onCompare?: (words: string[]) => void;
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
  onRemoveVocabFromPhrase?: (phraseId: string, vocabId: string) => void;
  /** When provided, DetailView enters "sentence mode": aligned 1:1 with `groups`, sentenceItems[i] is
   *  the saved sentence whose source card is groups[i]. Drives the banner, SRS, TTS, autoplay & delete. */
  sentenceItems?: StoredItem[];
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
  onSearch,
  onRefresh,
  onLazyLoadImage,
  onUpdateSRS,
  onCompare,
  onSaveSentence,
  isSentenceSaved,
  onRemoveVocabFromPhrase,
  sentenceItems,
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
  const [cardCollapsed, setCardCollapsed] = useState(true); // sentence review: word card collapsed → the sentence is the full-page focus
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [autoPlaySpeed, setAutoPlaySpeed] = useState(2000); // ms
  const [autoPlayTimerMinutes, setAutoPlayTimerMinutes] = useState(10);
  const [autoPlayStartedAt, setAutoPlayStartedAt] = useState<number | null>(null);
  const [, setAutoPlayNowTick] = useState(0);
  const [isSentenceAutoPlaying, setIsSentenceAutoPlaying] = useState(false);
  const [sentenceGap, setSentenceGap] = useState(2000); // ms of silence between sentences (end → next start)
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
      setCurrentItemIndex(0);
    }
  }, [currentGroupIndex]);

  // Lazy load image from Firebase if missing locally
  useEffect(() => {
    if (!currentItem || !onLazyLoadImage) return;
    
    const itemId = currentItem.data.id;
    const imageUrl = getItemImageUrl(currentItem);
    
    // Check if this item is saved and missing an image
    const isSaved = savedItemsRef.current.some(i => i.data.id === itemId);
    const hasImage = imageUrl && (imageUrl.startsWith('data:image/') || imageUrl === 'idb:stored' || imageUrl === 'server:has_image');

    if (isSaved && !hasImage) {
      // Trigger lazy load from Firebase
      onLazyLoadImage(itemId);
    }
  }, [currentItem?.data.id, onLazyLoadImage]);


  if (!currentItem) {
    return null;
  }
  
  const data = currentItem.data;
  const type = currentItem.type;

  // ── Sentence mode ────────────────────────────────────────────────────────────
  // Opened from the Sentences tab: each group is one saved sentence's source card, and
  // sentenceItems[currentGroupIndex] is the sentence being reviewed. Drives the banner,
  // SRS/TTS/delete targeting, and the natural-voice sentence autoplay.
  const sentenceMode = !!(sentenceItems && sentenceItems.length > 0);
  // Clamp to the (possibly shrunk-by-deletion) list so the shown card AND the "i / N" counter stay valid
  // even when the local index is briefly stale relative to the latest sentenceItems.
  const sentenceIndex = sentenceMode ? Math.min(currentGroupIndex, sentenceItems!.length - 1) : 0;
  const currentSentence = sentenceMode ? (sentenceItems![sentenceIndex] ?? null) : null;
  const currentSentenceText = currentSentence ? (currentSentence.data as SentenceData).text : '';

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
  const sentenceMastery = currentSentence?.srs ? SRSAlgorithm.getMasteryLevel(currentSentence.srs) : null;
  const sentenceMasteryColors = sentenceMastery ? getMasteryColors(sentenceMastery.color) : null;
  const { sentenceMemorizedCount, sentenceDueCount } = useMemo(() => {
    const list = sentenceItems ?? [];
    const now = Date.now();
    return {
      sentenceMemorizedCount: list.filter(s => (s.srs?.memoryStrength ?? 0) >= 70).length,
      sentenceDueCount: list.filter(s => (s.srs?.nextReview ?? 0) <= now).length,
    };
  }, [sentenceItems]);

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
  
  const onContentTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };
  
  const onContentTouchEnd = (e: React.TouchEvent) => {
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
    const container = scrollContainerRef.current;
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

    // ── Sentence review mode: ←/→ speak the saved sentence; ↑/↓ switch sentence + speak it ──
    if (sentenceMode) {
      if (isVerticalSwipe && isShortSwipe && diffY > 0 && isAtTop) {
        setShowHeader(true);                                    // keep short-swipe-down → reveal header
      } else if (isVerticalSwipe && isLongSwipe) {
        if (diffY < -longSwipeMin && (isAtBottom || scrollHeight <= clientHeight)) {
          goToSentence(currentGroupIndexRef.current + 1);      // swipe up → next sentence
        } else if (diffY > longSwipeMin && isAtTop) {
          goToSentence(currentGroupIndexRef.current - 1);      // swipe down → previous sentence
        }
      } else if (isHorizontalSwipe) {
        speakCurrentSentence();                                 // swipe ←/→ → speak current sentence
      }
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }

    // ── Eyes-free zone tap (word-card / phrase view): a still one-finger tap on blank space reads by
    // SCREEN HALF. Word card → top half = 1st example sentence, bottom half = 2nd. Phrase → top half =
    // the phrase itself, bottom half = its first Key Vocabulary example (matching the on-screen layout:
    // phrase up top, vocab examples below). The target is a whole screen half (not a small,
    // position-shifting icon), so it works on an iPad without looking. Clickable words, buttons and
    // links are excluded so normal tapping still works; tapping the same half again pauses/resumes. ──
    const TAP_MOVE_MAX = 10; // px — finger essentially didn't move → it's a tap, not a swipe/scroll
    if (absX <= TAP_MOVE_MAX && absY <= TAP_MOVE_MAX) {
      const tapTarget = e.target as HTMLElement | null;
      const onControl = !!tapTarget?.closest(
        'button, a, [role="button"], input, textarea, select, label, [contenteditable="true"]'
      );
      if (!onControl) {
        const topHalf = e.changedTouches[0].clientY < window.innerHeight / 2;
        if (currentItem && isPhraseItem(currentItem)) {
          const phrase = currentItem.data as SearchResult;
          const firstVocabExample = (phrase.vocabs || [])
            .flatMap(v => v.examples || [])
            .map(s => stripSentenceMarkers(s || '').trim())
            .find(Boolean);
          toggleSpeak(topHalf ? phrase.query : (firstVocabExample || phrase.query));
        } else {
          const count = examplesOf(currentItem).length;
          if (count > 0) {
            speakSentenceAt(Math.min(topHalf ? 0 : 1, count - 1)); // single example → either half reads it
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
  const GAP_PRESETS = [1000, 2000, 3000, 5000, 10000];
  const cycleGap = useCallback(() => {
    setSentenceGap(prev => {
      const idx = GAP_PRESETS.indexOf(prev);
      return GAP_PRESETS[(idx + 1) % GAP_PRESETS.length];
    });
  }, []);

  const toggleSentenceAutoPlay = useCallback(() => {
    setIsSentenceAutoPlaying(prev => {
      const next = !prev;
      if (next) setIsAutoPlaying(false);
      return next;
    });
  }, []);

  // Sentences to read for a card during auto-play: a phrase's query, or a vocab card's example
  // sentences (both — capped at 2 to match the E / Cmd+1·2 readers). Stripped, empties dropped.
  const examplesOf = (item: StoredItem | null): string[] => {
    if (!item) return [];
    if (isPhraseItem(item)) {
      const q = stripSentenceMarkers((item.data as SearchResult).query || '');
      return q ? [q] : [];
    }
    const ex = (item.data as VocabCard).examples;
    return (Array.isArray(ex) ? ex.slice(0, 2) : []).map(stripSentenceMarkers).filter(Boolean);
  };

  const sentenceGapRef = useRef(sentenceGap);
  useEffect(() => { sentenceGapRef.current = sentenceGap; }, [sentenceGap]);

  useEffect(() => {
    if (!isSentenceAutoPlaying || !groups) return;

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
    let gapTimer: ReturnType<typeof setTimeout> | undefined;
    let handle: SpeakHandle | undefined;
    let idx = 0;
    let rep = 0;

    // Deliberate action → allow the one-time model download. Each sentence is spoken twice with a
    // short beat between the two reads; the configurable gap separates distinct sentences within a
    // card, and moving to the NEXT card uses a short beat instead. (In sentence mode each card is a
    // single saved sentence, so the configurable gap applies across cards there too.)
    const REPEATS = 2;      // speak each sentence twice
    const REPEAT_GAP = 700; // short beat between the two reads of the same sentence
    const CARD_GAP = 600;   // short beat between cards in item mode
    const playNext = () => {
      if (idx >= sentences.length) { gapTimer = setTimeout(advanceCard, CARD_GAP); return; }
      const s = sentences[idx];
      const afterEach = () => {
        if (++rep < REPEATS) { gapTimer = setTimeout(playNext, REPEAT_GAP); return; } // read again
        rep = 0;
        idx++;
        const more = idx < sentences.length;
        const gap = (more || sentenceModeRef.current) ? sentenceGapRef.current : CARD_GAP;
        gapTimer = setTimeout(more ? playNext : advanceCard, gap);
      };
      handle = speakNatural(s, { allowDownload: true, onEnd: afterEach, onError: afterEach });
    };

    if (!sentences.length) {
      gapTimer = setTimeout(advanceCard, 400); // card has no example → move on quickly
    } else {
      playNext();
    }

    return () => {
      handle?.stop();
      if (gapTimer) clearTimeout(gapTimer);
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
  // restart from the top; otherwise start fresh. Shared by the Cmd+1·2 readers and the eyes-free zone tap.
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
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    speakNatural(sentence, { allowDownload: true });
  }, []);

  // Cmd/Ctrl+1 / +2: read the displayed card's first / second example sentence (a phrase has one:
  // its query). A second press on the same sentence pauses/resumes — unless it's almost finished, in
  // which case it restarts from the top.
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
    if (clamped === currentGroupIndexRef.current) { speakCurrentSentence(); return; } // already at an end → re-speak
    setIsAutoPlaying(false);
    setIsSentenceAutoPlaying(false);
    setShowHeader(false);
    setIsAnimating(true);
    setCurrentGroupIndex(clamped);
    setCurrentItemIndex(0);
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    setTimeout(() => setIsAnimating(false), 300);
    const next = list[clamped];
    const sentence = next ? stripSentenceMarkers((next.data as SentenceData).text || '').trim() : '';
    if (sentence) speakNatural(sentence, { allowDownload: true });
  }, [speakCurrentSentence]);

  // Arrow keys / trackpad wheel: in sentence mode ←/→ speak and ↑/↓ switch+speak; else normal nav.
  const navLeft = useCallback(() => { if (sentenceModeRef.current) speakCurrentSentence(); else handlePrevItem(); }, [handlePrevItem, speakCurrentSentence]);
  const navRight = useCallback(() => { if (sentenceModeRef.current) speakCurrentSentence(); else handleNextItem(); }, [handleNextItem, speakCurrentSentence]);
  const navUp = useCallback(() => { if (sentenceModeRef.current) goToSentence(currentGroupIndexRef.current - 1); else handlePrevGroup(); }, [handlePrevGroup, goToSentence]);
  const navDown = useCallback(() => { if (sentenceModeRef.current) goToSentence(currentGroupIndexRef.current + 1); else handleNextGroup(); }, [handleNextGroup, goToSentence]);

  // Stop any playback when DetailView closes (covers a manual read still going at close time).
  useEffect(() => () => { stopCurrent(); }, []);

  // Keyboard navigation
  useKeyboardNavigation({
    onEscape: onClose,
    onArrowLeft: navLeft,
    onArrowRight: navRight,
    onArrowUp: navUp,
    onArrowDown: navDown,
    onEnter: handleEnterFromSelection,
    onSave: handleToggleSave,
    enabled: !showActionMenu,
  });

  // Trackpad wheel navigation
  useWheelNavigation({
    onScrollLeft: navLeft,
    onScrollRight: navRight,
    containerRef: scrollContainerRef,
    threshold: 80,
    enabled: !!(currentGroup && currentGroup.items.length >= 1),
  });

  const handleVocabSearch = (term: string) => {
    onSearch(term);
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
      const s = currentSentenceRef.current;
      log('🔄 DetailView: Resetting SRS for sentence:', s.data.id);
      onSave({ ...s, srs: SRSAlgorithm.createNew(s.data.id, 'sentence') });
      setShowActionMenu(false);
      return;
    }
    // Reset SRS progress
    if (!data.id) return;
    
    log('🔄 DetailView: Resetting SRS for item:', data.id, title);
    
    const targetTitle = (title || '').toLowerCase().trim();
    // Find all siblings to reset them together (Shared SRS)
    const siblings = savedItemsRef.current.filter(item =>
      !item.isDeleted && getItemTitle(item).toLowerCase().trim() === targetTitle
    );

    if (siblings.length > 0) {
      siblings.forEach(sibling => {
         const newSRS = SRSAlgorithm.createNew(sibling.data.id, sibling.type);
         onSave({
           ...sibling,
           srs: newSRS,
         });
      });
    } else {
       // Fallback for current item if not found in saved list (e.g. slight delay in sync)
       const newSRS = SRSAlgorithm.createNew(data.id, type);
       onSave({
         data: data,
         type: type,
         savedAt: Date.now(),
         srs: newSRS
       });
    }
    
    setShowActionMenu(false);
  }, [data, title, type, onSave]);

  const handleRemember = useCallback(() => {
    // Sentence mode: remember THIS sentence (its own SRS), show the success overlay, then auto-advance.
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
      onUpdateSRS?.(s.data.id);
      setShowSuccessAnim(true);
      setTimeout(() => {
        setShowSuccessAnim(false);
        setRememberInfo(null);
        // Auto-advance to the next saved sentence; close back to the tab when this was the last.
        const len = sentenceItemsRef.current?.length ?? 0;
        const cur = currentGroupIndexRef.current;
        if (cur + 1 >= len) { onClose(); return; }
        setCurrentGroupIndex(cur + 1);
        setCurrentItemIndex(0);
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      }, 1500);
      return;
    }

    log('🧠 DetailView: Marking as remembered via shortcut/gesture');

    const targetTitle = (title || '').toLowerCase().trim();
    // Find all siblings to update them together (Shared SRS)
    const siblings = savedItemsRef.current.filter(item =>
      !item.isDeleted && getItemTitle(item).toLowerCase().trim() === targetTitle
    );

    if (siblings.length > 0) {
      // Compute preview SRS to show next review date in the animation
      const bestSibling = siblings.reduce((best, s) => {
        const bReviews = best.srs?.totalReviews || 0;
        const sReviews = s.srs?.totalReviews || 0;
        return sReviews > bReviews ? s : best;
      });
      const baseSRS = SRSAlgorithm.ensure(bestSibling.srs, bestSibling.data.id, bestSibling.type);
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

      // Use the dedicated onUpdateSRS if available (preferred - handles shared SRS atomically)
      if (onUpdateSRS) {
        // Update using the first sibling's ID - onUpdateSRS handles all siblings with same title
        log('🧠 DetailView: Using onUpdateSRS for atomic shared SRS update');
        onUpdateSRS(siblings[0].data.id);
      } else {
        // Fallback: Compute SRS update once, apply to all siblings
        log('🧠 DetailView: Using onSave fallback for SRS update');
        const updatedSRS = previewSRS;
        siblings.forEach(sibling => {
          onSave({
            ...sibling,
            srs: { ...updatedSRS, id: sibling.data.id }
          });
        });
      }
    } else {
      // Create new item and immediately mark as remembered
      if (!data.id) return;

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
    }, 1500);
  }, [data, type, onSave, onUpdateSRS, title, onClose]);

  const handleDoubleClick = () => {
    // Avoid triggering when selecting text
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
       return;
    }

    log('👆👆 DetailView: Double click detected');
    handleRemember();
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (showActionMenu) return;

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

      // Cmd/Ctrl+1 / +2: Read the first / second example sentence aloud (neural voice)
      if ((e.metaKey || e.ctrlKey) && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        speakSentenceAt(e.key === '1' ? 0 : 1);
      }

      // R: Remember (Shift+R: Reset)
      if (e.key === 'r' || e.key === 'R') {
         if (e.shiftKey) {
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
          if (isSaved || sentenceMode) handleDeleteItem();
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
          else toggleSentenceAutoPlay();              // idle/loading → start/stop continuous auto-play
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
  }, [title, showActionMenu, handleRemember, handleResetSRS, handleToggleSave, isSaved, cycleSpeed, readBothSentences, speakSentenceAt, sentenceMode, toggleSentenceAutoPlay]);

  return (
    <div 
      className="fixed inset-0 z-50 bg-slate-50 flex flex-col animate-in slide-in-from-right duration-300 shadow-2xl"
    >
      {/* Sentence-mode banner — the saved sentence's "card header": back, the sentence + natural-voice
          speaker, position, and the complete memorization/statistics row. Sits above the scroll area. */}
      {sentenceMode && currentSentence && (
        <div
          className={`bg-white border-b border-slate-200 px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 shadow-sm ${cardCollapsed ? 'flex-1 flex flex-col min-h-0' : 'shrink-0'}`}
          onTouchStart={onContentTouchStart}
          onTouchEnd={onContentTouchEnd}
        >
          <div className={`max-w-3xl mx-auto w-full ${cardCollapsed ? 'flex-1 flex flex-col min-h-0' : ''}`}>
            {/* Row 1: back + position */}
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <button
                onClick={onClose}
                className="flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-indigo-600 -ml-1 px-1 py-0.5 rounded-lg hover:bg-slate-100 transition-colors"
                title="Back to Sentences (Esc)"
              >
                <ArrowLeft size={18} /> Sentences
              </button>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full">
                  <MessageSquareQuote size={12} /> {sentenceIndex + 1} / {sentenceItems?.length ?? 0}
                </span>
                {sentenceDueCount > 0 && (
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
                <p
                  className={`max-w-2xl mx-auto text-center font-normal leading-relaxed tracking-tight text-slate-800 cursor-pointer select-text ${cardCollapsed ? 'text-2xl sm:text-4xl' : 'text-lg sm:text-xl'}`}
                  onClick={toggleSentencePlayback}
                  title="Tap to play / pause · double-click a word to play from it (Enter on a selected word)"
                >
                  <HighlightedSentence text={currentSentenceText} itemWord={(currentSentence.data as SentenceData).sourceWord} onPlayFromWord={playFromWordOffset} />
                </p>
                <div className="mt-5 flex justify-center">
                  <SentenceSpeakerButton text={stripSentenceMarkers(currentSentenceText)} />
                </div>
              </div>
            </div>

            {/* Toggle the supporting word card below */}
            <div className="shrink-0 flex justify-center mt-1">
              <button
                onClick={() => setCardCollapsed((v) => !v)}
                className="flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-indigo-600 px-2.5 py-1 rounded-lg hover:bg-slate-100 transition-colors"
                title={cardCollapsed ? 'Show word card' : 'Hide word card'}
              >
                {cardCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                {cardCollapsed ? 'Word card' : 'Hide card'}
              </button>
            </div>

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
                <button onClick={handleResetSRS} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors" title="Reset memory (Shift+R)">
                  <RotateCcw size={15} />
                </button>
                <button onClick={handleDeleteItem} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="Delete sentence (D)">
                  <Trash2 size={15} />
                </button>
                <button onClick={handleRemember} className="flex items-center gap-1 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 rounded-lg transition-colors" title="Remember (R)">
                  <CheckCircle2 size={14} /> Got it
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Word card — the supporting source-word detail. Hidden in sentence review when collapsed
          (so the sentence owns the page); always shown in regular card mode. */}
      {(!sentenceMode || !cardCollapsed) && (
      <div
        ref={scrollContainerRef}
        className={`flex-1 overflow-y-auto no-scrollbar transition-opacity duration-300 ${isAnimating ? 'opacity-50' : 'opacity-100'}`}
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
                className="min-h-full shadow-none border-0 !p-0 bg-transparent !h-auto !overflow-visible max-w-3xl md:max-w-5xl lg:max-w-6xl mx-auto"
                showRefresh={false}
                onCompare={onCompare}
                onSaveSentence={onSaveSentence}
                isSentenceSaved={isSentenceSaved}
                onLazyLoadImage={onLazyLoadImage}
              />
            </ErrorBoundary>
          )}

          {type === 'phrase' && (
            <div className="space-y-6 max-w-3xl md:max-w-5xl lg:max-w-6xl mx-auto">
              <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="md:flex">
                  <div className="bg-slate-100 relative overflow-hidden flex items-center justify-center group max-h-48 md:max-h-none md:w-2/5 md:shrink-0">
                    {(data as SearchResult).imageUrl ? (
                      <OfflineImage src={(data as SearchResult).imageUrl?.startsWith('data:') ? (data as SearchResult).imageUrl : undefined} itemId={(data as SearchResult).id} alt="Visual context" className="w-full h-full object-cover fade-in transition-transform duration-700 group-hover:scale-105" onMissing={onLazyLoadImage} />
                    ) : (
                      <div className="flex flex-col items-center text-slate-400 py-8">
                        <SearchIcon className="mb-2 opacity-30" size={32}/>
                        <span className="text-xs uppercase font-bold tracking-wider opacity-60">{(data as SearchResult).visualKeyword}</span>
                      </div>
                    )}
                  </div>

                <div className="p-6 sm:p-8 md:flex-1 md:min-w-0">
                  <div className="mb-6">
                    <h2 className="text-2xl font-bold text-slate-900 leading-tight mb-2">{(data as SearchResult).translation}</h2>
                    <p className="text-lg text-slate-600 mb-3 leading-relaxed">{(data as SearchResult).query}</p>
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

                  <div className="prose prose-indigo prose-sm sm:prose-base max-w-none text-slate-600">
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
      )}

      {/* Auto-play control */}
      <div className="fixed bottom-6 right-6 z-[60] flex items-center gap-2">
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
            onClick={cycleGap}
            className="bg-white/90 backdrop-blur-sm text-slate-600 text-sm font-bold px-3 py-2 rounded-full shadow-lg border border-slate-200 hover:bg-slate-50 transition-colors"
            title="Gap between sentences"
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

    </div>
  );
};
