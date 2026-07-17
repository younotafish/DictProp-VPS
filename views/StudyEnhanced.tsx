/**
 * Study and learning analytics.
 * 
 * Features:
 * - Real-time learning analytics derived from item-level SRS data
 * - Memory strength visualization
 * - Mastery breakdown by category
 * - 7-day activity chart (derived from item lastReviewDate)
 * - Achievement tracking
 * 
 * Review sessions use the same item-level FSRS state and authoritative event stream as quick review.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StoredItem, getItemSpelling, getItemTitle, ReviewEvent, type ReviewRating, type ReviewTaskType } from '../types';
import { 
  Trophy, 
  TrendingUp, 
  Flame, 
  BrainCircuit, 
  BarChart3,
  Zap,
  Target,
  Clock,
  Eye,
  Volume2,
  Undo2,
  X,
} from 'lucide-react';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { speakNatural } from '../services/lazyTts';
import { buildReviewQueue, createClozePrompt, formatReviewInterval, getStudyContent, selectReviewTask, stripStudyMarkers } from '../services/studySession';

interface StudyEnhancedProps {
  items: StoredItem[];
  reviewEvents: ReviewEvent[];
  onReview: (
    itemId: string,
    rating: ReviewRating,
    context: { taskType: ReviewTaskType; durationMs: number; sessionId: string; eventId: string },
  ) => Promise<boolean>;
  onUndoReview: (eventId: string) => Promise<void>;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

interface StudySession {
  id: string;
  itemIds: string[];
  index: number;
  revealed: boolean;
  typedAnswer: string;
  promptStartedAt: number;
  ratings: Record<ReviewRating, number>;
}

interface LastGrade {
  eventId: string;
  sessionId: string;
  itemId: string;
  itemIndex: number;
  rating: ReviewRating;
  taskType: ReviewTaskType;
  durationMs: number;
  typedAnswer: string;
  status: 'syncing' | 'ready' | 'waiting' | 'undoing';
}

const emptyRatings = (): Record<ReviewRating, number> => ({ again: 0, hard: 0, good: 0, easy: 0 });
const keyboardRatings: Partial<Record<string, ReviewRating>> = {
  '1': 'again',
  '2': 'hard',
  '3': 'good',
  '4': 'easy',
};

export const StudyEnhanced: React.FC<StudyEnhancedProps> = ({ 
  items, 
  reviewEvents,
  onReview,
  onUndoReview,
  onScroll,
}) => {
  // Scroll container ref for position restoration
  const dashboardScrollRef = React.useRef<HTMLDivElement>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [session, setSession] = useState<StudySession | null>(null);
  const [lastGrade, setLastGrade] = useState<LastGrade | null>(null);
  const [undoError, setUndoError] = useState('');

  const reviewQueue = useMemo(() => {
    return buildReviewQueue(items);
  }, [items]);

  const currentItem = session && session.index < session.itemIds.length
    ? items.find(item => item.data.id === session.itemIds[session.index]) || null
    : null;
  const sessionComplete = !!session && session.index >= session.itemIds.length;

  const startSession = () => {
    if (reviewQueue.length === 0) return;
    setLastGrade(null);
    setUndoError('');
    setSession({
      id: crypto.randomUUID(),
      itemIds: reviewQueue.map(item => item.data.id),
      index: 0,
      revealed: false,
      typedAnswer: '',
      promptStartedAt: Date.now(),
      ratings: emptyRatings(),
    });
  };

  const gradeCurrent = (rating: ReviewRating) => {
    if (!session || !currentItem || !session.revealed) return;
    const taskType = selectReviewTask(currentItem);
    const eventId = crypto.randomUUID();
    const grade: LastGrade = {
      eventId,
      sessionId: session.id,
      itemId: currentItem.data.id,
      itemIndex: session.index,
      rating,
      taskType,
      durationMs: Math.max(0, Date.now() - session.promptStartedAt),
      typedAnswer: session.typedAnswer,
      status: 'syncing',
    };
    setLastGrade(grade);
    setUndoError('');
    void onReview(currentItem.data.id, rating, {
      taskType,
      durationMs: grade.durationMs,
      sessionId: session.id,
      eventId,
    }).then(synced => {
      setLastGrade(current => current?.eventId === eventId
        ? { ...current, status: synced ? 'ready' : 'waiting' }
        : current);
    }).catch(() => {
      setLastGrade(current => current?.eventId === eventId ? { ...current, status: 'waiting' } : current);
    });
    setSession(current => current ? {
      ...current,
      index: current.index + 1,
      revealed: false,
      typedAnswer: '',
      promptStartedAt: Date.now(),
      ratings: { ...current.ratings, [rating]: current.ratings[rating] + 1 },
    } : null);
  };

  const undoLastGrade = async () => {
    const grade = lastGrade;
    if (!grade || !session || grade.sessionId !== session.id || grade.status === 'undoing') return;
    setLastGrade(current => current?.eventId === grade.eventId ? { ...current, status: 'undoing' } : current);
    setUndoError('');
    try {
      await onUndoReview(grade.eventId);
      setSession(current => current ? {
        ...current,
        index: grade.itemIndex,
        revealed: true,
        typedAnswer: grade.typedAnswer,
        promptStartedAt: Date.now(),
        ratings: {
          ...current.ratings,
          [grade.rating]: Math.max(0, current.ratings[grade.rating] - 1),
        },
      } : null);
      setLastGrade(null);
    } catch (error) {
      setLastGrade(current => current?.eventId === grade.eventId ? { ...current, status: 'waiting' } : current);
      setUndoError(error instanceof Error ? error.message : 'The review could not be undone.');
    }
  };

  const closeSession = () => {
    setLastGrade(null);
    setUndoError('');
    setSession(null);
  };

  useEffect(() => {
    if (!session) return;
    const handleSessionKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSession();
        return;
      }
      if (isTyping) return;
      if (event.key.toLowerCase() === 'u' && lastGrade && lastGrade.status !== 'undoing') {
        event.preventDefault();
        void undoLastGrade();
        return;
      }
      if (!session.revealed && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        setSession(current => current ? { ...current, revealed: true } : null);
        return;
      }
      if (!session.revealed) return;
      const rating = keyboardRatings[event.key];
      if (rating) {
        event.preventDefault();
        gradeCurrent(rating);
      }
    };
    window.addEventListener('keydown', handleSessionKey);
    return () => window.removeEventListener('keydown', handleSessionKey);
  }, [session, currentItem, lastGrade]);

  // Cleanup scroll save timer
  useEffect(() => () => { if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current); }, []);
  
  // Restore dashboard scroll position on mount
  useEffect(() => {
    const savedScroll = localStorage.getItem('study_dashboard_scroll');
    if (savedScroll && dashboardScrollRef.current) {
      const scrollY = parseInt(savedScroll, 10);
      setTimeout(() => {
        dashboardScrollRef.current?.scrollTo(0, scrollY);
      }, 100);
    }
  }, []);

  // Calculate comprehensive statistics — derived entirely from item-level SRS data
  const stats = useMemo(() => {
    const now = Date.now();
    // The session buries same-spelling senses, so the dashboard count follows the same rule.
    const dueSpellings = new Set<string>();
    items.forEach(i => {
      if ((i.srs?.nextReview ?? 0) <= now) {
        const spelling = getItemSpelling(i);
        if (spelling) dueSpellings.add(spelling);
      }
    });
    const due = dueSpellings.size;

    // Memory strength based categories (per PRODUCT_SUMMARY.md spec)
    const grandmaster = items.filter(i => (i.srs?.memoryStrength ?? 0) >= 85).length;
    const mastered = items.filter(i => (i.srs?.memoryStrength ?? 0) >= 70 && (i.srs?.memoryStrength ?? 0) < 85).length;
    const proficient = items.filter(i => (i.srs?.memoryStrength ?? 0) >= 50 && (i.srs?.memoryStrength ?? 0) < 70).length;
    const learning = items.filter(i => (i.srs?.memoryStrength ?? 0) >= 30 && (i.srs?.memoryStrength ?? 0) < 50).length;
    const struggling = items.filter(i => (i.srs?.memoryStrength ?? 0) >= 10 && (i.srs?.memoryStrength ?? 0) < 30).length;
    const newItems = items.filter(i => (i.srs?.memoryStrength ?? 0) < 10).length;

    const dateKey = (timestamp: number): string => {
      const d = new Date(timestamp);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const reviewDateSet = new Set(reviewEvents.map(event => dateKey(event.reviewedAt)));

    // Calculate consecutive day streak from item-level review dates
    let streak = 0;
    const todayDate = new Date();
    for (let i = 0; i < 365; i++) {
      const checkDate = new Date(todayDate);
      checkDate.setDate(checkDate.getDate() - i);
      const checkDateStr = dateKey(checkDate.getTime());
      
      if (reviewDateSet.has(checkDateStr)) {
        streak++;
      } else if (i === 0) {
        // If today hasn't been studied yet, check from yesterday
        continue;
      } else {
        break;
      }
    }
    
    // Average memory strength
    const avgStrength = items.length > 0
      ? items.reduce((sum, i) => sum + (i.srs?.memoryStrength ?? 0), 0) / items.length
      : 0;

    // Weekly stats derived from item-level SRS data (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoTimestamp = weekAgo.getTime();

    const weeklyEvents = reviewEvents.filter(event => event.reviewedAt >= weekAgoTimestamp);
    const weeklyReviews = weeklyEvents.length;
    const weeklyRecallRate = weeklyEvents.length > 0
      ? Math.round((weeklyEvents.filter(event => event.rating !== 'again').length / weeklyEvents.length) * 100)
      : 0;

    // Total lifetime reviews across all items
    const legacyReviewFloor = items.reduce((sum, i) => sum + (i.srs?.totalReviews ?? 0), 0);
    const totalLifetimeReviews = Math.max(reviewEvents.length, legacyReviewFloor);

    // Card-level metrics
    const longestStreak = items.length > 0
      ? Math.max(...items.map(i => i.srs?.correctStreak ?? 0))
      : 0;
    
    const mostReviewed = [...items]
      .sort((a, b) => (b.srs?.totalReviews ?? 0) - (a.srs?.totalReviews ?? 0))
      .slice(0, 3);

    // Get last 7 days for chart — count items reviewed on each day
    const last7Days: { date: string; reviews: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = dateKey(d.getTime());
      const dayReviews = reviewEvents.filter(event => dateKey(event.reviewedAt) === dateStr).length;
      last7Days.push({
        date: dateStr,
        reviews: dayReviews,
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
      avgStrength: Math.round(avgStrength),
      streak,
      weeklyReviews,
      weeklyRecallRate,
      totalLifetimeReviews,
      longestStreak,
      mostReviewed,
      last7Days
    };
  }, [items, reviewEvents]);

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

  if (session) {
    if (sessionComplete || !currentItem) {
      const remembered = session.ratings.hard + session.ratings.good + session.ratings.easy;
      return (
        <div className="h-full overflow-y-auto bg-slate-50 p-5 pb-24">
          <div className="max-w-xl mx-auto pt-10">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-bold text-slate-800">Session complete</h2>
              <button onClick={closeSession} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200" aria-label="Close session summary"><X size={20} /></button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 border-y border-slate-200 py-5 mb-6">
              {(['again', 'hard', 'good', 'easy'] as ReviewRating[]).map(rating => (
                <div key={rating} className="text-center">
                  <div className="text-2xl font-bold text-slate-800">{session.ratings[rating]}</div>
                  <div className="text-xs capitalize text-slate-500">{rating}</div>
                </div>
              ))}
            </div>
            <p className="text-sm text-slate-600 mb-6">Recalled {remembered} of {session.itemIds.length} prompts.</p>
            {lastGrade && (
              <button onClick={() => void undoLastGrade()} disabled={lastGrade.status === 'undoing'} className="mb-3 w-full h-12 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-100 disabled:opacity-60 inline-flex items-center justify-center gap-2" aria-keyshortcuts="U">
                <Undo2 size={18} /> {lastGrade.status === 'undoing' ? 'Undoing...' : 'Undo last rating'}
              </button>
            )}
            {undoError && <p className="mb-3 text-sm text-rose-700" role="alert">{undoError}</p>}
            <button onClick={closeSession} className="w-full h-12 bg-slate-900 text-white font-semibold rounded-lg hover:bg-slate-800">Return to study</button>
          </div>
        </div>
      );
    }

    const task = selectReviewTask(currentItem);
    const content = getStudyContent(currentItem);
    const example = stripStudyMarkers(content.example);
    const previews = SRSAlgorithm.previewRatings(currentItem.srs);
    const prompt = task === 'meaning'
      ? content.word
      : task === 'production'
        ? (content.chinese || content.definition)
        : task === 'cloze'
          ? createClozePrompt(content.example, content.word)
          : '';
    return (
      <div className="h-full overflow-y-auto bg-slate-50 p-4 pb-24">
        <div className="max-w-2xl mx-auto min-h-full flex flex-col">
          <header className="h-14 flex items-center justify-between border-b border-slate-200">
            <span className="text-sm font-semibold text-slate-600">{session.index + 1} / {session.itemIds.length}</span>
            <span className="text-xs font-medium uppercase text-slate-400">{task}</span>
            <div className="flex items-center gap-1">
              {lastGrade && (
                <button onClick={() => void undoLastGrade()} disabled={lastGrade.status === 'undoing'} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200 disabled:opacity-50" aria-label="Undo last rating" aria-keyshortcuts="U" title="Undo last rating">
                  <Undo2 size={19} />
                </button>
              )}
              <button onClick={closeSession} className="w-11 h-11 grid place-items-center rounded-full text-slate-500 hover:bg-slate-200" aria-label="End study session"><X size={20} /></button>
            </div>
          </header>

          {undoError && <p className="mt-3 text-sm text-rose-700" role="alert">{undoError}</p>}

          <section className="flex-1 flex flex-col justify-center py-10 text-center">
            {task === 'listening' ? (
              <button
                onClick={() => speakNatural(example, { allowDownload: true })}
                className="mx-auto w-16 h-16 rounded-full bg-slate-900 text-white grid place-items-center hover:bg-slate-800"
                aria-label="Play listening prompt"
              >
                <Volume2 size={26} />
              </button>
            ) : (
              <div className={task === 'meaning' ? 'text-4xl font-bold text-slate-900' : 'text-xl leading-relaxed text-slate-800'}>{prompt}</div>
            )}

            {task === 'production' && !session.revealed && (
              <input
                autoFocus
                value={session.typedAnswer}
                onChange={event => setSession(current => current ? { ...current, typedAnswer: event.target.value } : null)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setSession(current => current ? { ...current, revealed: true } : null);
                  }
                }}
                className="mt-8 mx-auto w-full max-w-md h-12 px-4 rounded-lg border border-slate-300 bg-white text-center text-lg text-slate-900 focus:border-slate-600 focus:outline-none"
                aria-label="Type the recalled word"
                autoComplete="off"
                spellCheck={false}
              />
            )}

            {session.revealed ? (
              <div className="mt-10 pt-8 border-t border-slate-200 text-left" aria-live="polite">
                <div className="text-3xl font-bold text-slate-900 mb-2">{content.word}</div>
                {task === 'production' && session.typedAnswer && (
                  <div className="text-sm text-slate-500 mb-3">Your answer: <span className="font-medium text-slate-700">{session.typedAnswer}</span></div>
                )}
                {content.chinese && <div className="text-lg text-slate-700 mb-2">{content.chinese}</div>}
                {content.definition && <div className="text-sm leading-relaxed text-slate-600 mb-4">{content.definition}</div>}
                {example && <div className="text-sm leading-relaxed text-slate-500 border-l-2 border-slate-300 pl-3">{example}</div>}
              </div>
            ) : (
              <button
                onClick={() => setSession(current => current ? { ...current, revealed: true } : null)}
                className="mt-12 mx-auto h-12 px-6 inline-flex items-center gap-2 bg-white border border-slate-300 rounded-lg font-semibold text-slate-700 hover:bg-slate-100"
                aria-keyshortcuts="Space Enter"
              >
                <Eye size={18} /> Reveal answer
              </button>
            )}
          </section>

          {session.revealed && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-slate-200 pt-4">
              {(['again', 'hard', 'good', 'easy'] as ReviewRating[]).map(rating => (
                <button
                  key={rating}
                  onClick={() => gradeCurrent(rating)}
                  aria-keyshortcuts={String((['again', 'hard', 'good', 'easy'] as ReviewRating[]).indexOf(rating) + 1)}
                  className={`h-14 rounded-lg border font-semibold capitalize ${rating === 'again' ? 'border-rose-300 text-rose-700 bg-rose-50' : rating === 'hard' ? 'border-amber-300 text-amber-700 bg-amber-50' : rating === 'good' ? 'border-emerald-300 text-emerald-700 bg-emerald-50' : 'border-blue-300 text-blue-700 bg-blue-50'}`}
                >
                  <span className="block">{rating}</span>
                  <span className="block text-[11px] font-normal opacity-75">{formatReviewInterval(previews[rating].interval)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

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
    <div 
      ref={dashboardScrollRef}
      className="h-full overflow-y-auto bg-slate-50 p-6 pb-[calc(5rem+env(safe-area-inset-bottom))]" 
      onScroll={(e) => {
        const scrollTop = e.currentTarget.scrollTop;
        if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = setTimeout(() => {
          localStorage.setItem('study_dashboard_scroll', scrollTop.toString());
        }, 500);
        onScroll?.(e);
      }}
    >
      <h2 className="text-3xl font-bold text-slate-800 mb-6">Today&apos;s Study</h2>

      <section className="border-y border-slate-200 py-5 mb-6 flex flex-wrap items-center justify-between gap-5">
        <div className="flex items-center gap-8">
          <div>
            <div className="text-2xl font-bold text-slate-900">{reviewQueue.length}</div>
            <div className="text-sm text-slate-500">Ready</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900">{stats.due}</div>
            <div className="text-sm text-slate-500">Due</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900">{stats.avgStrength}%</div>
            <div className="text-sm text-slate-500">Avg strength</div>
          </div>
        </div>
        <button
          onClick={startSession}
          disabled={reviewQueue.length === 0}
          className="h-12 px-5 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
        >
          {reviewQueue.length > 0 ? 'Start review' : 'Nothing due'}
        </button>
      </section>

      <section className="py-5 border-b border-slate-200 mb-2">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <BarChart3 size={16} className="text-indigo-500" />
            <span className="text-sm font-bold text-slate-700">Weekly Stats</span>
          </div>
          <span className="text-xs text-slate-400">Last 7 days</span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-xl font-bold text-slate-800">{stats.weeklyReviews}</p>
            <p className="text-xs text-slate-500">Reviews</p>
          </div>
          <div>
            <p className="text-xl font-bold text-emerald-700">{stats.weeklyRecallRate}%</p>
            <p className="text-xs text-slate-500">Recalled</p>
          </div>
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-1">
              <Flame size={16} className={stats.streak > 0 ? 'text-orange-500' : 'text-slate-300'} />
              <p className="text-xl font-bold text-slate-800">{stats.streak}</p>
            </div>
            <p className="text-xs text-slate-500">Day Streak</p>
          </div>
        </div>
      </section>

      {/* Mastery Breakdown */}
      {stats.total > 0 && (
        <section className="py-5 border-b border-slate-200 mb-2">
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
        </section>
      )}

      {/* 7-Day Activity Chart */}
      <section className="py-5 border-b border-slate-200 mb-2">
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
      </section>

      {/* Card-Level Metrics */}
      <section className="py-5 border-b border-slate-200 mb-2">
        <div className="flex items-center gap-2 mb-4">
          <Trophy size={16} className="text-amber-500" />
          <span className="text-sm font-bold text-slate-700">Achievements</span>
        </div>
        
        <div className="grid grid-cols-2 divide-x divide-slate-200 border-y border-slate-200">
          {/* Longest Streak */}
          <div className="py-4 pr-4">
            <div className="flex items-center gap-2 mb-1">
              <Zap size={14} className="text-amber-500" />
              <span className="text-xs font-medium text-slate-600">Best Streak</span>
            </div>
            <p className="text-2xl font-bold text-slate-800">{stats.longestStreak}</p>
            <p className="text-xs text-slate-500">correct in a row</p>
          </div>
          
          {/* Total Reviews */}
          <div className="py-4 pl-4">
            <div className="flex items-center gap-2 mb-1">
              <Clock size={14} className="text-blue-500" />
              <span className="text-xs font-medium text-slate-600">Total Reviews</span>
            </div>
            <p className="text-2xl font-bold text-slate-800">
              {stats.totalLifetimeReviews}
            </p>
            <p className="text-xs text-slate-500">all time</p>
          </div>
        </div>

        {/* Most Reviewed */}
        {stats.mostReviewed.length > 0 && (stats.mostReviewed[0].srs?.totalReviews ?? 0) > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <p className="text-xs font-medium text-slate-600 mb-2">Most Practiced</p>
            <div className="flex flex-wrap gap-2">
              {stats.mostReviewed.slice(0, 3).map((item, idx) => (
                <span 
                  key={idx}
                  className="px-2 py-1 bg-emerald-50 text-emerald-700 text-xs rounded-full font-medium"
                >
                  {getItemTitle(item)} ({item.srs?.totalReviews ?? 0}x)
                </span>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
