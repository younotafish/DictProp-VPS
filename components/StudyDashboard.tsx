import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { BarChart3, Clock, Flame, Target, TrendingUp, Trophy, Zap } from 'lucide-react';
import { getItemTitle, type ReviewEvent, type StoredItem } from '../types';
import { buildReviewQueue } from '../services/studySession';
import { computeStudyStats } from '../services/studyStats';

const SCROLL_KEY = 'study_dashboard_scroll';

interface StudyDashboardProps {
  items: StoredItem[];
  reviewEvents: ReviewEvent[];
  onStart: (queue: StoredItem[]) => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

/**
 * The study tab between sessions: what's ready, and progress so far. It's only mounted while no session
 * runs, so grading a card never recomputes these numbers, and it returns to where it was scrolled.
 */
export const StudyDashboard = React.memo(function StudyDashboard({ items, reviewEvents, onStart, onScroll }: StudyDashboardProps) {
  const dashboardScrollRef = useRef<HTMLDivElement>(null);
  // The latest scroll position not yet saved, and the timer that saves it.
  const unsavedScrollRef = useRef<number | null>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reviewQueue = useMemo(() => buildReviewQueue(items), [items]);
  const stats = useMemo(() => computeStudyStats(items, reviewEvents), [items, reviewEvents]);

  const saveScroll = () => {
    clearTimeout(scrollSaveTimerRef.current);
    if (unsavedScrollRef.current === null) return;
    try { localStorage.setItem(SCROLL_KEY, String(unsavedScrollRef.current)); } catch { /* storage full or unavailable */ }
    unsavedScrollRef.current = null;
  };

  // Open at the saved scroll position before the first paint, instead of at the top and then jumping.
  // When the dashboard goes away (a session starts or another tab shows), save a position still waiting
  // on its timer, so coming back doesn't jump.
  useLayoutEffect(() => {
    const savedScroll = Number(localStorage.getItem(SCROLL_KEY));
    if (savedScroll > 0 && dashboardScrollRef.current) dashboardScrollRef.current.scrollTop = savedScroll;
    return saveScroll;
  }, []);

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
        unsavedScrollRef.current = e.currentTarget.scrollTop;
        clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = setTimeout(saveScroll, 500);
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
          onClick={() => onStart(reviewQueue)}
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
                  {new Date(day.day).toLocaleDateString('en', { weekday: 'narrow' })}
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
});
