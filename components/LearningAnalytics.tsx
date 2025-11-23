/**
 * Learning Analytics Dashboard
 * Visualizes progress, performance trends, and mastery insights
 */

import React from 'react';
import { StoredItem } from '../types';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { 
  TrendingUp, 
  Target, 
  Zap, 
  Clock, 
  Award,
  BarChart3,
  Calendar,
  Flame
} from 'lucide-react';

interface LearningAnalyticsProps {
  items: StoredItem[];
}

export const LearningAnalytics: React.FC<LearningAnalyticsProps> = ({ items }) => {
  // Calculate comprehensive analytics
  const calculateAnalytics = () => {
    if (items.length === 0) {
      return {
        totalItems: 0,
        avgStrength: 0,
        avgStability: 0,
        totalReviews: 0,
        masteryDistribution: { grandmaster: 0, mastered: 0, proficient: 0, learning: 0, struggling: 0, new: 0 },
        recentActivity: [],
        strongestWords: [],
        weakestWords: [],
        longestStreak: 0,
        currentStreak: 0
      };
    }

    const totalItems = items.length;
    const avgStrength = items.reduce((sum, i) => sum + i.srs.memoryStrength, 0) / totalItems;
    const avgStability = items.reduce((sum, i) => sum + i.srs.stability, 0) / totalItems;
    const totalReviews = items.reduce((sum, i) => sum + i.srs.totalReviews, 0);

    // Mastery distribution
    const masteryDistribution = {
      grandmaster: items.filter(i => i.srs.memoryStrength >= 85).length,
      mastered: items.filter(i => i.srs.memoryStrength >= 70 && i.srs.memoryStrength < 85).length,
      proficient: items.filter(i => i.srs.memoryStrength >= 50 && i.srs.memoryStrength < 70).length,
      learning: items.filter(i => i.srs.memoryStrength >= 30 && i.srs.memoryStrength < 50).length,
      struggling: items.filter(i => i.srs.memoryStrength >= 10 && i.srs.memoryStrength < 30).length,
      new: items.filter(i => i.srs.memoryStrength < 10).length,
    };

    // Recent activity (last 30 days)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const recentReviews = items.filter(i => i.srs.lastReviewDate >= thirtyDaysAgo);
    
    // Activity by day
    const activityByDay: { [date: string]: number } = {};
    recentReviews.forEach(item => {
      const date = new Date(item.srs.lastReviewDate).toISOString().split('T')[0];
      activityByDay[date] = (activityByDay[date] || 0) + 1;
    });
    const recentActivity = Object.entries(activityByDay)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 7);

    // Strongest and weakest words
    const sortedByStrength = [...items].sort((a, b) => b.srs.memoryStrength - a.srs.memoryStrength);
    const strongestWords = sortedByStrength.slice(0, 5).map(i => ({
      word: i.type === 'vocab' ? (i.data as any).word : (i.data as any).query,
      strength: i.srs.memoryStrength,
      stability: i.srs.stability
    }));
    const weakestWords = sortedByStrength.slice(-5).reverse().map(i => ({
      word: i.type === 'vocab' ? (i.data as any).word : (i.data as any).query,
      strength: i.srs.memoryStrength,
      stability: i.srs.stability
    }));

    // Streak calculation
    const sortedByDate = [...items]
      .filter(i => i.srs.totalReviews > 0)
      .sort((a, b) => b.srs.lastReviewDate - a.srs.lastReviewDate);
    
    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;
    let lastDate: string | null = null;
    
    sortedByDate.forEach(item => {
      const date = new Date(item.srs.lastReviewDate).toISOString().split('T')[0];
      if (!lastDate) {
        tempStreak = 1;
        lastDate = date;
      } else {
        const dayDiff = (new Date(lastDate).getTime() - new Date(date).getTime()) / (1000 * 60 * 60 * 24);
        if (dayDiff <= 1) {
          tempStreak++;
        } else {
          if (tempStreak > longestStreak) longestStreak = tempStreak;
          tempStreak = 1;
        }
        lastDate = date;
      }
    });
    
    const today = new Date().toISOString().split('T')[0];
    const mostRecentDate = sortedByDate[0] ? new Date(sortedByDate[0].srs.lastReviewDate).toISOString().split('T')[0] : null;
    if (mostRecentDate === today || mostRecentDate === new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]) {
      currentStreak = tempStreak;
    }
    if (tempStreak > longestStreak) longestStreak = tempStreak;

    return {
      totalItems,
      avgStrength: Math.round(avgStrength),
      avgStability: Math.round(avgStability * 10) / 10,
      totalReviews,
      masteryDistribution,
      recentActivity,
      strongestWords,
      weakestWords,
      longestStreak,
      currentStreak
    };
  };

  const analytics = calculateAnalytics();

  if (items.length === 0) {
    return (
      <div className="p-8 text-center text-slate-500">
        <BarChart3 size={48} className="mx-auto mb-4 text-slate-300" />
        <p>No data yet. Start studying to see your analytics!</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 bg-slate-50">
      <h2 className="text-2xl font-bold text-slate-800 mb-6">Learning Analytics</h2>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-violet-100 text-violet-600 rounded-full flex items-center justify-center">
              <Zap size={20} fill="currentColor" />
            </div>
            <span className="text-xs font-bold text-slate-500 uppercase">Avg Strength</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">{analytics.avgStrength}%</p>
          <div className="mt-3 h-2 bg-slate-100 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-violet-500 to-purple-500 transition-all" 
              style={{ width: `${analytics.avgStrength}%` }}
            />
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
              <Clock size={20} />
            </div>
            <span className="text-xs font-bold text-slate-500 uppercase">Stability</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">{analytics.avgStability}d</p>
          <p className="text-xs text-slate-400 mt-2">Average retention time</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center">
              <TrendingUp size={20} />
            </div>
            <span className="text-xs font-bold text-slate-500 uppercase">Total Reviews</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">{analytics.totalReviews}</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center">
              <Flame size={20} fill="currentColor" />
            </div>
            <span className="text-xs font-bold text-slate-500 uppercase">Streak</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">{analytics.currentStreak}</p>
          <p className="text-xs text-slate-400 mt-2">Best: {analytics.longestStreak} days</p>
        </div>
      </div>

      {/* Mastery Distribution */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <h3 className="text-sm font-bold text-slate-700 mb-4 flex items-center gap-2">
          <Target size={16} />
          Mastery Distribution
        </h3>
        <div className="space-y-3">
          {Object.entries(analytics.masteryDistribution).map(([level, count]) => {
            const percentage = (count / analytics.totalItems) * 100;
            const colors: { [key: string]: string } = {
              grandmaster: 'bg-purple-500',
              mastered: 'bg-emerald-500',
              proficient: 'bg-blue-500',
              learning: 'bg-amber-500',
              struggling: 'bg-orange-500',
              new: 'bg-slate-400'
            };
            
            return (
              <div key={level}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-slate-600 capitalize">{level}</span>
                  <span className="text-xs font-bold text-slate-800">{count}</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div 
                    className={`h-full ${colors[level]} transition-all`}
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <h3 className="text-sm font-bold text-slate-700 mb-4 flex items-center gap-2">
          <Calendar size={16} />
          Recent Activity (Last 7 Days)
        </h3>
        <div className="flex items-end justify-between gap-2 h-32">
          {analytics.recentActivity.map(({ date, count }) => {
            const maxCount = Math.max(...analytics.recentActivity.map(a => a.count));
            const height = (count / maxCount) * 100;
            
            return (
              <div key={date} className="flex-1 flex flex-col items-center gap-2">
                <div 
                  className="w-full bg-gradient-to-t from-indigo-500 to-violet-400 rounded-t-lg transition-all hover:from-indigo-600 hover:to-violet-500"
                  style={{ height: `${height}%`, minHeight: '4px' }}
                  title={`${count} reviews`}
                />
                <span className="text-[10px] text-slate-400 font-medium">
                  {new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top and Bottom Performers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Strongest */}
        <div className="bg-white p-6 rounded-2xl border border-emerald-200 shadow-sm">
          <h3 className="text-sm font-bold text-emerald-700 mb-4 flex items-center gap-2">
            <Award size={16} />
            Strongest Words
          </h3>
          <div className="space-y-2">
            {analytics.strongestWords.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between p-2 bg-emerald-50 rounded-lg">
                <span className="font-medium text-slate-700 truncate">{item.word}</span>
                <span className="text-sm font-bold text-emerald-600">{item.strength}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* Weakest */}
        <div className="bg-white p-6 rounded-2xl border border-orange-200 shadow-sm">
          <h3 className="text-sm font-bold text-orange-700 mb-4 flex items-center gap-2">
            <Target size={16} />
            Needs Practice
          </h3>
          <div className="space-y-2">
            {analytics.weakestWords.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between p-2 bg-orange-50 rounded-lg">
                <span className="font-medium text-slate-700 truncate">{item.word}</span>
                <span className="text-sm font-bold text-orange-600">{item.strength}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

