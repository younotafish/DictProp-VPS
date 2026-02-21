/**
 * Study Dashboard View — Learning Analytics
 * 
 * Features:
 * - Real-time learning analytics derived from item-level SRS data
 * - Memory strength visualization
 * - Mastery breakdown by category
 * - 7-day activity chart (derived from item lastReviewDate)
 * - Achievement tracking
 * 
 * Note: Study sessions (flashcard review) have been deprecated.
 * SRS updates now happen through the DetailView (double-click or R key).
 * All stats are derived from item-level SRS fields (lastReviewDate, totalReviews).
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { StoredItem, VocabCard, SearchResult } from '../types';
import { 
  Trophy, 
  TrendingUp, 
  Flame, 
  BrainCircuit, 
  BarChart3,
  Zap,
  Target,
  Clock,
} from 'lucide-react';

interface StudyEnhancedProps {
  items: StoredItem[];
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

export const StudyEnhanced: React.FC<StudyEnhancedProps> = ({ 
  items, 
  onScroll,
}) => {
  // Scroll container ref for position restoration
  const dashboardScrollRef = React.useRef<HTMLDivElement>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

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
    // Deduplicate due count by spelling — one word = one due item regardless of sense count
    const dueSpellings = new Set<string>();
    items.forEach(i => {
      if ((i.srs?.nextReview ?? 0) <= now) {
        const spelling = (i.type === 'phrase' ? (i.data as any).query : (i.data as any).word || '').toLowerCase().trim();
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

    // Collect review dates from items for streak + chart calculation
    // Each item's lastReviewDate tells us the most recent day it was reviewed
    const reviewDateSet = new Set<string>();
    for (const item of items) {
      if (item.srs?.lastReviewDate && (item.srs?.totalReviews ?? 0) > 0) {
        const dateStr = new Date(item.srs.lastReviewDate).toISOString().split('T')[0];
        reviewDateSet.add(dateStr);
      }
    }

    // Calculate consecutive day streak from item-level review dates
    let streak = 0;
    const todayDate = new Date();
    for (let i = 0; i < 365; i++) {
      const checkDate = new Date(todayDate);
      checkDate.setDate(checkDate.getDate() - i);
      const checkDateStr = checkDate.toISOString().split('T')[0];
      
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

    // Count items reviewed in the last 7 days
    const itemsReviewedThisWeek = items.filter(
      i => (i.srs?.lastReviewDate ?? 0) >= weekAgoTimestamp && (i.srs?.totalReviews ?? 0) > 0
    );
    const weeklyReviews = itemsReviewedThisWeek.length;

    // Average memory strength of items reviewed this week (proxy for accuracy)
    const weeklyAvgStrength = itemsReviewedThisWeek.length > 0
      ? itemsReviewedThisWeek.reduce((sum, i) => sum + (i.srs?.memoryStrength ?? 0), 0) / itemsReviewedThisWeek.length
      : 0;

    // Total lifetime reviews across all items
    const totalLifetimeReviews = items.reduce((sum, i) => sum + (i.srs?.totalReviews ?? 0), 0);

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
      const dateStr = d.toISOString().split('T')[0];
      // Count items whose lastReviewDate falls on this day
      const dayReviews = items.filter(item => {
        if (!item.srs?.lastReviewDate || (item.srs?.totalReviews ?? 0) === 0) return false;
        const reviewDateStr = new Date(item.srs.lastReviewDate).toISOString().split('T')[0];
        return reviewDateStr === dateStr;
      }).length;
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
      weeklyAvgStrength: Math.round(weeklyAvgStrength),
      totalLifetimeReviews,
      longestStreak,
      mostReviewed,
      last7Days
    };
  }, [items]);

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
      <h2 className="text-3xl font-bold text-slate-800 mb-1">Today&apos;s Study</h2>
      <p className="text-slate-500 mb-8">Adaptive recall with spaced repetition</p>

      {/* Summary Card */}
      <div className="bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-600 rounded-3xl p-6 shadow-xl mb-6 relative overflow-hidden text-white">
        <div className="relative z-10">
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-5xl font-extrabold tracking-tighter">{stats.due}</span>
            <span className="text-violet-200 font-medium text-lg">due now</span>
          </div>
          <div className="text-sm text-violet-100 font-medium">
            <span>Avg retention: {stats.avgStrength}%</span>
          </div>
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
          <span className="text-xs text-slate-400">Last 7 days</span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-xl font-bold text-slate-800">{stats.weeklyReviews}</p>
            <p className="text-xs text-slate-500">Reviews</p>
          </div>
          <div>
            <p className="text-xl font-bold text-emerald-600">{stats.weeklyAvgStrength}%</p>
            <p className="text-xs text-slate-500">Avg Strength</p>
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
          
          {/* Total Reviews */}
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-3">
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
      </div>
    </div>
  );
};
