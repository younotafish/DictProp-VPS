/**
 * Enhanced Study View with Advanced SRS and Flashcard Interface
 * 
 * Features:
 * - "Simplified SuperMemo" logic: Memory Strength + Stability
 * - Simple Flashcard UI: Front (Question) / Back (Answer)
 * - Binary Choice: Memorized vs Not Memorized
 * - Real-time learning analytics
 * - Memory strength visualization
 */

import React, { useState, useEffect, useCallback } from 'react';
import { StoredItem, TaskType, VocabCard, SearchResult } from '../types';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { Button } from '../components/Button';
import { OfflineImage } from '../components/OfflineImage';
import { PronunciationBlock } from '../components/PronunciationBlock';
import { VocabCardDisplay } from '../components/VocabCard';
import ReactMarkdown from 'react-markdown';
import { speak } from '../services/speech';
import { 
  Trophy, 
  TrendingUp, 
  Flame, 
  BrainCircuit, 
  BarChart3,
  Zap,
  Target,
  Clock,
  Trash2,
  Archive,
  Play,
  Search as SearchIcon,
  RefreshCw,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { recordStudySession, loadSessionHistory, SessionRecord } from '../services/firebase';

interface StudyEnhancedProps {
  items: StoredItem[];
  onUpdateSRS: (itemId: string, quality: number, taskType: TaskType, responseTime: number) => void;
  onSearch: (text: string) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  userId?: string; // For Firebase sync
  onLazyLoadImage?: (itemId: string) => void; // Fetch image from Firebase if missing locally
}

type StudyMode = 'dashboard' | 'session' | 'complete';

export const StudyEnhanced: React.FC<StudyEnhancedProps> = ({ 
  items, 
  onUpdateSRS, 
  onSearch, 
  onDelete,
  onArchive,
  onScroll,
  userId,
  onLazyLoadImage
}) => {
  const [mode, setMode] = useState<StudyMode>('dashboard');
  const [queue, setQueue] = useState<StoredItem[]>([]);
  const [sessionStartTime, setSessionStartTime] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [cardStartTime, setCardStartTime] = useState(0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [meaningIndex, setMeaningIndex] = useState(0); // For carousel navigation within same-spelling words
  const touchStartX = React.useRef<number | null>(null);
  const touchStartY = React.useRef<number | null>(null);
  const touchStartTime = React.useRef<number | null>(null);
  
  const [sessionStats, setSessionStats] = useState({
    reviews: 0,
    correct: 0,
    totalTime: 0
  });

  // Historical session data from Firebase
  const [sessionHistory, setSessionHistory] = useState<SessionRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Helper to get the title/spelling of an item
  const getItemSpelling = (item: StoredItem): string => {
    if (item.type === 'vocab') {
      return ((item.data as VocabCard).word || '').toLowerCase().trim();
    }
    return ((item.data as SearchResult).query || '').toLowerCase().trim();
  };

  // Find all items in the full items list that have the same spelling as the current queue item
  const getSiblingMeanings = useCallback((): StoredItem[] => {
    if (!queue[0]) return [];
    const currentSpelling = getItemSpelling(queue[0]);
    if (!currentSpelling) return [queue[0]];
    
    // Find all items with the same spelling from the full items list
    const siblings = items.filter(item => 
      getItemSpelling(item) === currentSpelling && !item.isDeleted
    );
    
    return siblings.length > 0 ? siblings : [queue[0]];
  }, [queue, items]);

  const siblingMeanings = getSiblingMeanings();
  const hasMutipleMeanings = siblingMeanings.length > 1;
  const currentMeaningItem = hasMutipleMeanings ? siblingMeanings[meaningIndex] || queue[0] : queue[0];

  // Lazy load image from Firebase if missing locally
  useEffect(() => {
    if (!currentMeaningItem || !onLazyLoadImage) return;
    
    const itemData = currentMeaningItem.data as any;
    const hasImage = itemData.imageUrl && itemData.imageUrl.startsWith('data:image/');
    
    if (!hasImage && currentMeaningItem.data.id) {
      onLazyLoadImage(currentMeaningItem.data.id);
    }
  }, [currentMeaningItem?.data.id, onLazyLoadImage]);

  // Auto-pronounce word when card changes in study session
  useEffect(() => {
    if (mode !== 'session' || !currentMeaningItem) return;
    
    const text = currentMeaningItem.type === 'vocab' 
      ? (currentMeaningItem.data as VocabCard).word 
      : (currentMeaningItem.data as SearchResult).query;
    
    if (text) {
      const timer = setTimeout(() => {
        speak(text);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [mode, currentMeaningItem?.data.id, meaningIndex]);

  // Load session history from Firebase on mount
  useEffect(() => {
    if (!userId) return;
    
    const fetchHistory = async () => {
      setIsLoadingHistory(true);
      try {
        const history = await loadSessionHistory(userId, 30);
        setSessionHistory(history);
      } catch (error) {
        console.error('Failed to load session history:', error);
      } finally {
        setIsLoadingHistory(false);
      }
    };
    
    fetchHistory();
  }, [userId]);

  // Horizontal swipe handlers for meaning carousel (vertical swipe disabled - use buttons)
  // Only active on FRONT of card - back has selectable content that conflicts with swipe on iOS
  const handleMeaningTouchStart = (e: React.TouchEvent) => {
    // Don't track swipe when card is flipped - back side has selectable content
    if (isFlipped) return;
    
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    touchStartTime.current = Date.now();
  };

  const handleMeaningTouchEnd = (e: React.TouchEvent) => {
    // Don't process swipe when card is flipped - allows text selection on iOS
    if (isFlipped) {
      touchStartX.current = null;
      touchStartY.current = null;
      touchStartTime.current = null;
      return;
    }
    
    if (!touchStartX.current || !touchStartY.current || !touchStartTime.current) return;
    
    // Check if user is selecting text - don't interfere with text selection on iOS
    const selection = window.getSelection();
    const hasTextSelection = selection && selection.toString().trim().length > 0;
    if (hasTextSelection) {
      touchStartX.current = null;
      touchStartY.current = null;
      touchStartTime.current = null;
      return;
    }
    
    // Check touch duration - text selection/long press takes longer than a quick swipe
    // Only process as swipe if it was a quick gesture (< 300ms)
    const touchDuration = Date.now() - touchStartTime.current;
    const maxSwipeDuration = 300;
    if (touchDuration > maxSwipeDuration) {
      touchStartX.current = null;
      touchStartY.current = null;
      touchStartTime.current = null;
      return;
    }
    
    const diffX = e.changedTouches[0].clientX - touchStartX.current;
    const diffY = e.changedTouches[0].clientY - touchStartY.current;
    
    const absX = Math.abs(diffX);
    const absY = Math.abs(diffY);
    const swipeThreshold = 50;
    
    // Only horizontal swipe for meaning navigation (vertical swipe disabled)
    if (absX > absY * 1.5 && absX > swipeThreshold && hasMutipleMeanings) {
      if (diffX < -swipeThreshold && meaningIndex < siblingMeanings.length - 1) {
        // Swipe left -> next meaning
        setMeaningIndex(prev => prev + 1);
        setIsFlipped(false);
      } else if (diffX > swipeThreshold && meaningIndex > 0) {
        // Swipe right -> previous meaning
        setMeaningIndex(prev => prev - 1);
        setIsFlipped(false);
      }
    }
    
    touchStartX.current = null;
    touchStartY.current = null;
    touchStartTime.current = null;
  };

  const handleMouseDown = () => {
    // Long press disabled - archive uses button
  };

  const handleMouseUp = () => {
    // Long press disabled - archive uses button
  };
  
  // Handle archive from button
  const handleArchiveClick = () => {
    if (!onArchive || !currentMeaningItem) return;
    setShowArchiveConfirm(true);
  };

  // Calculate comprehensive statistics
  const getStats = () => {
    const now = Date.now();
    const due = items.filter(i => i.srs.nextReview <= now).length;
    
    // Memory strength based categories (per PRODUCT_SUMMARY.md spec)
    const grandmaster = items.filter(i => i.srs.memoryStrength >= 85).length;
    const mastered = items.filter(i => i.srs.memoryStrength >= 70 && i.srs.memoryStrength < 85).length;
    const proficient = items.filter(i => i.srs.memoryStrength >= 50 && i.srs.memoryStrength < 70).length;
    const learning = items.filter(i => i.srs.memoryStrength >= 30 && i.srs.memoryStrength < 50).length;
    const struggling = items.filter(i => i.srs.memoryStrength >= 10 && i.srs.memoryStrength < 30).length;
    const newItems = items.filter(i => i.srs.memoryStrength < 10).length;
    
    // Streak calculation from session history
    const today = new Date().toISOString().split('T')[0];
    const hasStudiedToday = sessionHistory.some(s => s.date === today) || items.some(i => {
      const lastReview = new Date(i.srs.lastReviewDate).toISOString().split('T')[0];
      return lastReview === today;
    });
    
    // Calculate consecutive day streak from session history
    let streak = 0;
    const sortedDates = [...new Set(sessionHistory.map(s => s.date))].sort().reverse();
    const todayDate = new Date();
    
    for (let i = 0; i < sortedDates.length; i++) {
      const expectedDate = new Date(todayDate);
      expectedDate.setDate(expectedDate.getDate() - i);
      const expectedDateStr = expectedDate.toISOString().split('T')[0];
      
      if (sortedDates.includes(expectedDateStr)) {
        streak++;
      } else if (i === 0 && !sortedDates.includes(expectedDateStr)) {
        // If today isn't studied yet, check from yesterday
        continue;
      } else {
        break;
      }
    }
    
    // Average memory strength
    const avgStrength = items.length > 0 
      ? items.reduce((sum, i) => sum + i.srs.memoryStrength, 0) / items.length 
      : 0;

    // Weekly stats from session history (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoTimestamp = weekAgo.getTime();
    const weekSessions = sessionHistory.filter(s => s.timestamp >= weekAgoTimestamp);
    
    const weeklyReviews = weekSessions.reduce((sum, s) => sum + s.reviews, 0);
    const weeklyAccuracy = weekSessions.length > 0
      ? weekSessions.reduce((sum, s) => sum + s.accuracy, 0) / weekSessions.length
      : 0;
    const weeklyStudyTime = weekSessions.reduce((sum, s) => sum + s.studyTime, 0);

    // Card-level metrics
    const longestStreak = items.length > 0
      ? Math.max(...items.map(i => i.srs.correctStreak || 0))
      : 0;
    
    const hardestCards = [...items]
      .sort((a, b) => (b.srs.difficulty || 0) - (a.srs.difficulty || 0))
      .slice(0, 3);
    
    const mostReviewed = [...items]
      .sort((a, b) => (b.srs.totalReviews || 0) - (a.srs.totalReviews || 0))
      .slice(0, 3);

    // Get last 7 days for chart
    const last7Days: { date: string; reviews: number; accuracy: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const daySession = sessionHistory.find(s => s.date === dateStr);
      last7Days.push({
        date: dateStr,
        reviews: daySession?.reviews || 0,
        accuracy: daySession?.accuracy || 0
      });
    }

    return { 
      due, 
      grandmaster, 
      mastered, 
      proficient,
      learning, 
      struggling,
      newItems,
      total: items.length,
      hasStudiedToday,
      avgStrength: Math.round(avgStrength),
      streak,
      weeklyReviews,
      weeklyAccuracy: Math.round(weeklyAccuracy),
      weeklyStudyTime,
      longestStreak,
      hardestCards,
      mostReviewed,
      last7Days
    };
  };

  const stats = getStats();

  const startSession = () => {
    const now = Date.now();
    
    // 1. Get due items
    const dueItems = items
      .filter(item => item.srs.nextReview <= now)
      .sort((a, b) => {
        // Prioritize lowest memory strength first, then oldest due (per PRODUCT_SUMMARY)
        const strengthDiff = (a.srs.memoryStrength || 0) - (b.srs.memoryStrength || 0);
        if (strengthDiff !== 0) return strengthDiff;
        return (a.srs.nextReview || 0) - (b.srs.nextReview || 0);
      });
    
    let studySet = [...dueItems];

    // 2. Backfill with struggling items if needed (up to 10)
    if (studySet.length < 10) {
      const needed = 10 - studySet.length;
      const candidates = items
        .filter(item => !studySet.find(d => d.data.id === item.data.id))
        .sort((a, b) => a.srs.memoryStrength - b.srs.memoryStrength); // Weakest first
      
      studySet = [...studySet, ...candidates.slice(0, needed)];
    }

    if (studySet.length === 0) {
      // No items to study - the button will be disabled anyway, but just in case
      return;
    }

    setQueue(studySet);
    setSessionTotal(studySet.length);
    setMode('session');
    setIsFlipped(false);
    setSessionStartTime(Date.now());
    setCardStartTime(Date.now());
    setSessionStats({ reviews: 0, correct: 0, totalTime: 0 });
  };

  const finishSession = useCallback(() => {
    setMode('complete');
    confetti({
      particleCount: 150,
      spread: 80,
      origin: { y: 0.6 }
    });
    
    // Record session to Firebase
    if (userId) {
      const accuracy = sessionStats.reviews > 0 
        ? (sessionStats.correct / sessionStats.reviews) * 100
        : 0;
      
      recordStudySession(userId, {
        reviews: sessionStats.reviews,
        studyTime: Date.now() - sessionStartTime,
        accuracy
      });
    }
  }, [userId, sessionStats, sessionStartTime]);

  const handleRate = useCallback((isMemorized: boolean) => {
    if (!queue[0] || !currentMeaningItem) return;

    const responseTime = Date.now() - cardStartTime;
    
    // Map binary choice to quality score per PRODUCT_SUMMARY.md spec:
    // Memorized -> 4 (Very good - moderate gain)
    // Not Memorized -> 1 (Hard Fail - moderate loss)
    const quality = isMemorized ? 4 : 1;

    // Update SRS for ALL sibling meanings - per PRODUCT_SUMMARY.md:
    // "All meanings share one SRS score"
    // "Single review updates all meanings of that word"
    // We use 'recall' as the standard task type for flashcards (tap to flip, self-grade)
    siblingMeanings.forEach(sibling => {
      onUpdateSRS(sibling.data.id, quality, 'recall', responseTime);
    });

    // Update session stats
    setSessionStats(prev => ({
      reviews: prev.reviews + 1,
      correct: prev.correct + (isMemorized ? 1 : 0),
      totalTime: prev.totalTime + responseTime
    }));

    // Move to next item
    const nextQueue = queue.slice(1);
    
    // Re-queue if failed (so we see it again this session)
    // Re-queue the first meaning as representative of the group
    if (!isMemorized) {
       nextQueue.push(queue[0]);
    }
    
    if (nextQueue.length === 0) {
      finishSession();
    } else {
      setQueue(nextQueue);
      setIsFlipped(false);
      setMeaningIndex(0); // Reset meaning index for next card
      setCardStartTime(Date.now());
    }
  }, [queue, cardStartTime, onUpdateSRS, finishSession, currentMeaningItem, siblingMeanings]);

  // Enhanced keyboard navigation for study mode
  useEffect(() => {
    if (mode !== 'session') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Arrow keys for rating
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleRate(false);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleRate(true);
      }
      
      // Space to flip card
      if (e.key === ' ' || e.key === 'Space') {
        e.preventDefault();
        setIsFlipped(prev => !prev);
      }
      
      // Enter to flip card (alternative)
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!isFlipped) {
          setIsFlipped(true);
        }
      }
      
      // Escape to exit session
      if (e.key === 'Escape') {
        e.preventDefault();
        setMode('dashboard');
      }
      
      // Arrow Up/Down for meaning navigation when multiple meanings
      if (hasMutipleMeanings) {
        if (e.key === 'ArrowUp' && meaningIndex > 0) {
          e.preventDefault();
          setMeaningIndex(prev => prev - 1);
          setIsFlipped(false);
        } else if (e.key === 'ArrowDown' && meaningIndex < siblingMeanings.length - 1) {
          e.preventDefault();
          setMeaningIndex(prev => prev + 1);
          setIsFlipped(false);
        }
      }
      
      // Number keys for quick rating (1 = Forgot, 2 = Archive, 3 = Got it)
      if (e.key === '1' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleRate(false);
      } else if (e.key === '3' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleRate(true);
      } else if (e.key === '2' && !e.metaKey && !e.ctrlKey && onArchive) {
        e.preventDefault();
        setShowArchiveConfirm(true);
      }
      
      // P key to pronounce current word
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (currentMeaningItem) {
          const text = currentMeaningItem.type === 'vocab' 
            ? (currentMeaningItem.data as VocabCard).word 
            : (currentMeaningItem.data as SearchResult).query;
          if (text) speak(text);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, handleRate, isFlipped, hasMutipleMeanings, meaningIndex, siblingMeanings.length, onArchive, currentMeaningItem]);

  const handleDeleteCurrent = () => {
    if (!currentMeaningItem) return;
    
    // Delete from global storage (delete the currently viewed meaning)
    onDelete(currentMeaningItem.data.id);
    
    // Update session stats (don't count as review)
    // Move to next item
    const nextQueue = queue.slice(1);
    
    if (nextQueue.length === 0) {
      // If that was the last one, we can go back to dashboard or finish
      // Since it's deleted, maybe just go back to dashboard
      setMode('dashboard');
    } else {
      setQueue(nextQueue);
      setIsFlipped(false);
      setMeaningIndex(0); // Reset meaning index
      setCardStartTime(Date.now());
    }
  };

  const handleArchiveCurrent = () => {
    if (!currentMeaningItem || !onArchive) return;
    
    // Archive the currently viewed meaning
    onArchive(currentMeaningItem.data.id);
    
    // Move to next item
    const nextQueue = queue.slice(1);
    
    if (nextQueue.length === 0) {
      setMode('dashboard');
    } else {
      setQueue(nextQueue);
      setIsFlipped(false);
      setMeaningIndex(0);
      setCardStartTime(Date.now());
    }
  };

  const renderFront = () => {
    if (!currentMeaningItem) return null;
    const item = currentMeaningItem;
    const isVocab = item.type === 'vocab';
    const frontText = isVocab ? (item.data as VocabCard).word : (item.data as SearchResult).query;
    const subText = isVocab ? (item.data as VocabCard).ipa : 'Phrase';
    const sense = isVocab ? (item.data as VocabCard).sense : undefined;

    return (
      <div 
        className="w-full h-full bg-gradient-to-br from-white to-indigo-50/30 rounded-[2rem] shadow-xl shadow-slate-200/60 border-2 border-indigo-100 flex flex-col justify-between p-8 cursor-pointer hover:shadow-2xl hover:-translate-y-1 hover:border-indigo-200 transition-all duration-300 relative overflow-hidden group"
        onClick={() => setIsFlipped(true)}
      >
        <div className="relative w-full h-8 shrink-0 flex justify-center items-center gap-2">
          <Play size={12} className="text-indigo-400 opacity-60" fill="currentColor" />
          <p className="text-[10px] font-bold text-indigo-400 tracking-widest uppercase opacity-60 group-hover:opacity-100 transition-opacity">
            <span className="md:hidden">Tap to reveal</span>
            <span className="hidden md:inline">Press Space or tap to reveal</span>
          </p>
        </div>

        <div className="flex-1 flex items-center justify-center w-full overflow-hidden my-4">
          <div className="max-h-full w-full overflow-y-auto no-scrollbar text-center px-2">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-800 break-words leading-tight tracking-tight mb-2">
              {frontText}
            </h2>
            {/* Show sense/meaning hint for words with multiple meanings */}
            {sense && (
              <span className="inline-block mt-2 px-3 py-1 bg-violet-100 text-violet-700 text-sm font-medium rounded-full">
                {sense}
              </span>
            )}
            <div className="w-16 h-1 bg-gradient-to-r from-transparent via-indigo-300 to-transparent mx-auto opacity-30 mt-3"></div>
          </div>
        </div>

        <div 
          className="shrink-0 flex flex-col items-center gap-6 pb-4 relative"
          onClick={(e) => e.stopPropagation()}
        >
          {subText && (
             <PronunciationBlock 
                text={frontText || ''}
                ipa={subText}
                className="text-lg bg-indigo-50 text-indigo-600 px-4 py-2 rounded-xl shadow-sm"
                showIcon={true}
             />
          )}
        </div>
      </div>
    );
  };

  const renderBack = () => {
    if (!currentMeaningItem) return null;
    const item = currentMeaningItem;
    
    if (item.type === 'vocab') {
      return (
        <div className="h-full w-full">
          <VocabCardDisplay 
            data={item.data as VocabCard}
            showSave={false}
            onSearch={onSearch}
            className="h-full w-full rounded-[2rem] border-0 shadow-xl"
            showAudio={true}
            showPronunciation={true}
          />
        </div>
      );
    } else {
      // Phrase View
      const data = item.data as SearchResult;
      return (
        <div 
          className="h-full w-full bg-white rounded-[2rem] shadow-xl border border-slate-100 overflow-y-auto relative select-text pb-8"
          style={{ WebkitUserSelect: 'text', userSelect: 'text' }}
        >
            {/* Hero Image */}
            <div className="aspect-video bg-slate-100 relative overflow-hidden flex items-center justify-center group shrink-0">
                <button 
                    onClick={(e) => { e.stopPropagation(); onSearch(data.query); }}
                    className="absolute top-4 right-4 z-20 bg-white/90 p-2 rounded-full shadow-md text-slate-400 hover:text-indigo-600 transition-colors"
                    title="Refresh / Search Again"
                >
                    <RefreshCw size={18} />
                </button>
                {data.imageUrl ? (
                    <OfflineImage src={data.imageUrl} alt="Visual context" className="w-full h-full object-cover" />
                ) : (
                    <div className="flex flex-col items-center text-slate-400">
                        <SearchIcon className="mb-2 opacity-30" size={32}/>
                        <span className="text-xs uppercase font-bold tracking-wider opacity-60">{data.visualKeyword}</span>
                    </div>
                )}
            </div>

            <div className="p-6 pb-10">
                <div className="mb-6">
                    <h2 className="text-2xl font-bold text-slate-900 leading-tight mb-2">{data.translation}</h2>
                    <p className="text-lg text-slate-600 mb-3 leading-relaxed">{data.query}</p>
                    <PronunciationBlock 
                        text={data.query}
                        ipa={data.pronunciation}
                        className="text-sm bg-slate-100 px-2 py-1 rounded-lg w-full"
                    />
                </div>
                
                <div className="prose prose-indigo prose-sm max-w-none text-slate-600 mb-6">
                    <ReactMarkdown 
                        components={{
                            strong: ({node, ...props}) => <span className="font-bold text-indigo-700 bg-indigo-50 px-1 rounded" {...props} />
                        }}
                    >
                        {data.grammar || ''}
                    </ReactMarkdown>
                </div>

                 {/* Included Vocab List */}
                 {((data.vocabs || []).length > 0) && (
                     <div>
                        <div className="mb-3 flex items-center gap-2">
                            <SearchIcon size={14} className="text-indigo-500" />
                            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Key Vocabulary</h3>
                        </div>
                        <div className="grid gap-3 pb-4">
                            {(data.vocabs || []).map((vocab) => (
                                <VocabCardDisplay 
                                    key={vocab.id}
                                    data={vocab} 
                                    onSave={() => {}}
                                    isSaved={false}
                                    onSearch={onSearch}
                                    scrollable={false}
                                    showSave={false}
                                    className="!h-auto !overflow-visible border border-slate-100 shadow-sm !p-4"
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
      );
    }
  };

  if (items.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-500 bg-slate-50">
        <div className="w-20 h-20 bg-slate-200 rounded-full flex items-center justify-center mb-4">
          <BrainCircuit size={40} className="text-slate-400" />
        </div>
        <h3 className="text-xl font-bold text-slate-700 mb-2">Your Study Space</h3>
        <p className="max-w-xs">Add vocabulary and phrases to your notebook to begin your learning journey with smart spaced repetition.</p>
      </div>
    );
  }

  // --- DASHBOARD VIEW ---
  if (mode === 'dashboard') {
    // Helper to get item title for display
    const getItemTitle = (item: StoredItem): string => {
      if (item.type === 'vocab') {
        return (item.data as VocabCard).word;
      }
      return (item.data as SearchResult).query;
    };

    // Mastery breakdown data for stacked bar
    const masteryData = [
      { label: 'Grandmaster', count: stats.grandmaster, color: 'bg-purple-500' },
      { label: 'Mastered', count: stats.mastered, color: 'bg-emerald-500' },
      { label: 'Proficient', count: stats.proficient, color: 'bg-blue-500' },
      { label: 'Learning', count: stats.learning, color: 'bg-amber-400' },
      { label: 'Struggling', count: stats.struggling, color: 'bg-orange-500' },
      { label: 'New', count: stats.newItems, color: 'bg-slate-300' },
    ];

    // Max reviews for chart scaling
    const maxReviews = Math.max(...stats.last7Days.map(d => d.reviews), 1);

    return (
      <div className="h-full overflow-y-auto bg-slate-50 p-6 pb-[calc(5rem+env(safe-area-inset-bottom))]" onScroll={onScroll}>
        <h2 className="text-3xl font-bold text-slate-800 mb-1">Today&apos;s Study</h2>
        <p className="text-slate-500 mb-8">Adaptive recall with spaced repetition</p>

        {/* Main Action Card (per doc) */}
        <div className="bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-600 rounded-3xl p-6 shadow-xl mb-6 relative overflow-hidden text-white">
          <div className="relative z-10">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-5xl font-extrabold tracking-tighter">{stats.due}</span>
              <span className="text-violet-200 font-medium text-lg">due now</span>
            </div>
            <div className="text-sm text-violet-100 mb-8 font-medium flex flex-col gap-1">
              <span>Avg retention: {stats.avgStrength}%</span>
              <span>Estimated: {Math.max(1, Math.ceil(stats.due * 0.5))} min</span>
            </div>
            <Button 
              onClick={startSession} 
              disabled={stats.due === 0 && items.length === 0}
              className="w-full py-4 text-lg bg-white text-violet-600 hover:bg-violet-50 border-0 font-bold shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {stats.due > 0 ? "Start Session" : "Practice Mode"}
            </Button>
          </div>
          <div className="absolute -right-8 -top-8 w-40 h-40 bg-white opacity-10 rounded-full blur-2xl"></div>
          <div className="absolute -left-8 -bottom-8 w-40 h-40 bg-purple-400 opacity-20 rounded-full blur-2xl"></div>
        </div>

        {/* Weekly stats summary - Now with real Firebase data */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm mb-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <BarChart3 size={16} className="text-indigo-500" />
              <span className="text-sm font-bold text-slate-700">Weekly Stats</span>
            </div>
            <span className="text-xs text-slate-400">
              {isLoadingHistory ? 'Loading...' : 'Last 7 days'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xl font-bold text-slate-800">{stats.weeklyReviews}</p>
              <p className="text-xs text-slate-500">Reviews</p>
            </div>
            <div>
              <p className="text-xl font-bold text-emerald-600">{stats.weeklyAccuracy}%</p>
              <p className="text-xs text-slate-500">Accuracy</p>
            </div>
            <div className="flex flex-col items-center">
              <div className="flex items-center gap-1">
                <Flame size={16} className={stats.streak > 0 ? 'text-orange-500' : 'text-slate-300'} />
                <p className="text-xl font-bold text-slate-800">{stats.streak}</p>
              </div>
              <p className="text-xs text-slate-500">Day Streak</p>
            </div>
          </div>
        </div>

        {/* Mastery Breakdown */}
        {stats.total > 0 && (
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm mb-4">
            <div className="flex items-center gap-2 mb-4">
              <Target size={16} className="text-indigo-500" />
              <span className="text-sm font-bold text-slate-700">Mastery Breakdown</span>
              <span className="text-xs text-slate-400 ml-auto">{stats.total} cards</span>
            </div>
            
            {/* Stacked Progress Bar */}
            <div className="h-4 rounded-full overflow-hidden flex bg-slate-100 mb-3">
              {masteryData.map((level, idx) => {
                const percentage = stats.total > 0 ? (level.count / stats.total) * 100 : 0;
                if (percentage === 0) return null;
                return (
                  <div
                    key={idx}
                    className={`${level.color} transition-all duration-500`}
                    style={{ width: `${percentage}%` }}
                    title={`${level.label}: ${level.count}`}
                  />
                );
              })}
            </div>
            
            {/* Legend */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              {masteryData.filter(l => l.count > 0).map((level, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <div className={`w-2.5 h-2.5 rounded-full ${level.color}`} />
                  <span className="text-slate-600 truncate">{level.label}</span>
                  <span className="text-slate-400 font-medium">{level.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 7-Day Activity Chart */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm mb-4">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={16} className="text-indigo-500" />
            <span className="text-sm font-bold text-slate-700">7-Day Activity</span>
          </div>
          
          {/* Mini Bar Chart */}
          <div className="flex items-end justify-between gap-1 h-20 mb-2">
            {stats.last7Days.map((day, idx) => {
              const height = maxReviews > 0 ? (day.reviews / maxReviews) * 100 : 0;
              const isToday = idx === 6;
              return (
                <div key={idx} className="flex-1 flex flex-col items-center gap-1">
                  <div className="w-full flex items-end justify-center" style={{ height: '60px' }}>
                    <div 
                      className={`w-full max-w-6 rounded-t transition-all duration-300 ${
                        day.reviews > 0 
                          ? isToday 
                            ? 'bg-violet-500' 
                            : 'bg-indigo-400'
                          : 'bg-slate-200'
                      }`}
                      style={{ height: `${Math.max(height, 8)}%` }}
                      title={`${day.reviews} reviews`}
                    />
                  </div>
                  <span className={`text-[10px] ${isToday ? 'font-bold text-slate-700' : 'text-slate-400'}`}>
                    {new Date(day.date).toLocaleDateString('en', { weekday: 'narrow' })}
                  </span>
                </div>
              );
            })}
          </div>
          
          {/* Summary row */}
          <div className="flex justify-between text-xs text-slate-500 pt-2 border-t border-slate-100">
            <span>Total: {stats.last7Days.reduce((sum, d) => sum + d.reviews, 0)} reviews</span>
            <span>
              Avg: {Math.round(stats.last7Days.reduce((sum, d) => sum + d.reviews, 0) / 7)}/day
            </span>
          </div>
        </div>

        {/* Card-Level Metrics */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm mb-4">
          <div className="flex items-center gap-2 mb-4">
            <Trophy size={16} className="text-amber-500" />
            <span className="text-sm font-bold text-slate-700">Achievements</span>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            {/* Longest Streak */}
            <div className="bg-gradient-to-br from-orange-50 to-amber-50 rounded-xl p-3">
              <div className="flex items-center gap-2 mb-1">
                <Zap size={14} className="text-amber-500" />
                <span className="text-xs font-medium text-slate-600">Best Streak</span>
              </div>
              <p className="text-2xl font-bold text-slate-800">{stats.longestStreak}</p>
              <p className="text-xs text-slate-500">correct in a row</p>
            </div>
            
            {/* Study Time */}
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-3">
              <div className="flex items-center gap-2 mb-1">
                <Clock size={14} className="text-blue-500" />
                <span className="text-xs font-medium text-slate-600">Study Time</span>
              </div>
              <p className="text-2xl font-bold text-slate-800">
                {Math.round(stats.weeklyStudyTime / 60000)}
              </p>
              <p className="text-xs text-slate-500">minutes this week</p>
            </div>
          </div>

          {/* Hardest Cards */}
          {stats.hardestCards.length > 0 && stats.hardestCards[0].srs.difficulty > 5 && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-xs font-medium text-slate-600 mb-2">Challenging Cards</p>
              <div className="flex flex-wrap gap-2">
                {stats.hardestCards.slice(0, 3).map((item, idx) => (
                  <button 
                    key={idx}
                    onClick={() => onSearch(getItemTitle(item))}
                    className="px-2 py-1 bg-rose-50 text-rose-700 text-xs rounded-full font-medium hover:bg-rose-100 active:scale-95 transition-all cursor-pointer"
                  >
                    {getItemTitle(item)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Most Reviewed */}
          {stats.mostReviewed.length > 0 && stats.mostReviewed[0].srs.totalReviews > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-xs font-medium text-slate-600 mb-2">Most Practiced</p>
              <div className="flex flex-wrap gap-2">
                {stats.mostReviewed.slice(0, 3).map((item, idx) => (
                  <button 
                    key={idx}
                    onClick={() => onSearch(getItemTitle(item))}
                    className="px-2 py-1 bg-emerald-50 text-emerald-700 text-xs rounded-full font-medium hover:bg-emerald-100 active:scale-95 transition-all cursor-pointer"
                  >
                    {getItemTitle(item)} ({item.srs.totalReviews}x)
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- COMPLETE VIEW ---
  if (mode === 'complete') {
    const accuracy = sessionStats.reviews > 0 
      ? Math.round((sessionStats.correct / sessionStats.reviews) * 100)
      : 0;
    const avgTime = sessionStats.reviews > 0 
      ? Math.round(sessionStats.totalTime / sessionStats.reviews / 1000)
      : 0;

    return (
      <div className="h-full flex flex-col items-center justify-center p-8 bg-gradient-to-br from-violet-600 to-indigo-600 text-white relative overflow-hidden">
        <div className="z-10 text-center">
          <div className="mb-6 animate-bounce-slow">
            <Trophy size={80} className="mx-auto text-yellow-300 drop-shadow-lg" fill="currentColor" />
          </div>
          <h2 className="text-4xl font-bold mb-3 tracking-tight">Brilliant Session!</h2>
          <p className="text-violet-200 mb-8 text-lg max-w-xs mx-auto">
            You've reviewed {sessionStats.reviews} {sessionStats.reviews === 1 ? 'card' : 'cards'} and strengthened your memory
          </p>

          {/* Session Summary */}
          <div className="bg-white/10 backdrop-blur-sm rounded-2xl p-6 mb-8 max-w-sm mx-auto">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-3xl font-bold mb-1">{sessionStats.reviews}</p>
                <p className="text-xs text-violet-200 uppercase tracking-wide">Cards</p>
              </div>
              <div>
                <p className="text-3xl font-bold mb-1 text-yellow-300">{accuracy}%</p>
                <p className="text-xs text-violet-200 uppercase tracking-wide">Accuracy</p>
              </div>
              <div>
                <p className="text-3xl font-bold mb-1">{avgTime}s</p>
                <p className="text-xs text-violet-200 uppercase tracking-wide">Avg Time</p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 w-full max-w-xs">
            <Button onClick={() => setMode('dashboard')} className="bg-white text-violet-600 hover:bg-violet-50 border-0 font-bold py-4">
              View Progress
            </Button>
            <Button onClick={startSession} className="text-white hover:bg-white/20 border-2 border-white/30 font-bold py-3">
              Study More
            </Button>
          </div>
        </div>
        
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-purple-500 rounded-full blur-[100px] opacity-50"></div>
          <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-indigo-500 rounded-full blur-[100px] opacity-50"></div>
        </div>
      </div>
    );
  }

  // --- SESSION VIEW ---
  return (
    <div className="fixed inset-0 z-50 bg-slate-100 flex flex-col animate-in slide-in-from-bottom duration-300">
      <div className="w-full max-w-md mx-auto h-full flex flex-col p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {/* Header */}
        <div className="flex justify-between items-center mb-4 shrink-0">
          <Button variant="ghost" size="sm" onClick={() => setMode('dashboard')} className="text-slate-400 hover:text-slate-600">
            &larr; End
          </Button>
          
          <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase bg-white px-3 py-1.5 rounded-full shadow-sm">
            <Clock size={14} />
            <span>
              Card {Math.min(sessionStats.reviews + 1, sessionTotal || sessionStats.reviews + queue.length)}/{sessionTotal || sessionStats.reviews + queue.length || 0}
            </span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-2 bg-slate-200 rounded-full mb-4 overflow-hidden shrink-0">
          <div 
            className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-500 ease-out" 
            style={{ width: `${(sessionStats.reviews + queue.length) > 0 ? Math.max(5, ((sessionStats.reviews) / (sessionStats.reviews + queue.length)) * 100) : 5}%` }} 
          />
        </div>

        {/* Meaning indicators (dots only) for multi-meaning words */}
        {hasMutipleMeanings && (
          <div className="flex flex-col items-center gap-2 mb-3 shrink-0">
            <div className="flex justify-center gap-2">
              {siblingMeanings.map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => { setMeaningIndex(idx); setIsFlipped(false); }}
                  className={`h-2 rounded-full transition-all ${
                    idx === meaningIndex 
                      ? 'bg-violet-500 w-5' 
                      : 'bg-slate-300 w-2 hover:bg-slate-400'
                  }`}
                  aria-label={`Meaning ${idx + 1}`}
                  title="Swipe left/right to change meaning"
                />
              ))}
            </div>
          </div>
        )}

        {/* Card Container */}
        <div 
          className="flex-1 relative perspective-1000 group w-full min-h-0 mb-1"
        onTouchStart={handleMeaningTouchStart}
        onTouchEnd={handleMeaningTouchEnd}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        >
           <div className={`relative w-full h-full transition-all duration-500 transform-style-3d ${isFlipped ? 'rotate-y-180' : ''}`}>
              
              {/* Front Face */}
              <div 
                className={`absolute inset-0 backface-hidden transition-opacity duration-75 delay-200 ${isFlipped ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
                style={{ WebkitBackfaceVisibility: 'hidden', backfaceVisibility: 'hidden' }}
              >
                 {renderFront()}
              </div>

              {/* Back Face */}
              <div 
                className={`absolute inset-0 rotate-y-180 backface-hidden transition-opacity duration-75 delay-200 select-text ${isFlipped ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                style={{ 
                  WebkitBackfaceVisibility: 'hidden', 
                  backfaceVisibility: 'hidden',
                  WebkitUserSelect: 'text',
                  userSelect: 'text'
                }}
              >
                 {renderBack()}
              </div>
           </div>
        </div>

        {/* Action Buttons - Three color bars: Forgot / Archive / Got it */}
        <div className="grid grid-cols-3 gap-3 shrink-0">
           <button 
             onClick={() => handleRate(false)}
             className="h-14 bg-rose-500 active:bg-rose-600 rounded-2xl shadow-lg shadow-rose-200 transition-all active:scale-95 flex items-center justify-center gap-2 group"
             aria-label="Forgot (press ← or 1)"
             title="Forgot (← or 1)"
           >
             <span className="hidden md:inline text-white/80 text-xs font-medium group-hover:text-white transition-colors">Forgot</span>
             <kbd className="hidden md:inline bg-white/20 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">←</kbd>
           </button>
           {onArchive && (
             <button 
               onClick={handleArchiveClick}
               className="h-14 bg-amber-400 active:bg-amber-500 rounded-2xl shadow-lg shadow-amber-200 transition-all active:scale-95 flex items-center justify-center gap-2 group"
               aria-label="Archive (press 2)"
               title="Archive (2)"
             >
               <span className="hidden md:inline text-white/80 text-xs font-medium group-hover:text-white transition-colors">Archive</span>
               <kbd className="hidden md:inline bg-white/20 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">2</kbd>
             </button>
           )}
           <button 
             onClick={() => handleRate(true)}
             className="h-14 bg-emerald-500 active:bg-emerald-600 rounded-2xl shadow-lg shadow-emerald-200 transition-all active:scale-95 flex items-center justify-center gap-2 group"
             aria-label="Got it (press → or 3)"
             title="Got it (→ or 3)"
           >
             <span className="hidden md:inline text-white/80 text-xs font-medium group-hover:text-white transition-colors">Got it</span>
             <kbd className="hidden md:inline bg-white/20 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">→</kbd>
           </button>
        </div>

      </div>
      
      {/* Archive prompt on long-press */}
      {showArchiveConfirm && onArchive && (
        <div className="fixed inset-0 z-[60] bg-black/25 backdrop-blur-[2px] flex items-center justify-center p-6 animate-in fade-in duration-150" onClick={() => setShowArchiveConfirm(false)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-6 text-center animate-in zoom-in-95 duration-150" onClick={e => e.stopPropagation()}>
                <div className="w-12 h-12 bg-amber-100 text-amber-500 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Archive size={24} />
                </div>
                <h3 className="text-lg font-bold text-slate-800 mb-2">Archive this card?</h3>
                <p className="text-sm text-slate-500 mb-6">
                    It will leave this session and future sessions until unarchived.
                </p>
                <div className="flex gap-3">
                    <Button variant="ghost" onClick={() => setShowArchiveConfirm(false)} className="flex-1">
                        Cancel
                    </Button>
                    <Button 
                        variant="primary" 
                        onClick={() => {
                            handleArchiveCurrent();
                            setShowArchiveConfirm(false);
                        }} 
                        className="flex-1 bg-amber-500 hover:bg-amber-600 shadow-amber-200 border-0"
                    >
                        Archive
                    </Button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};
