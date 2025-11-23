/**
 * Enhanced Study View with Advanced SRS and Multiple Task Types
 * 
 * Features:
 * - Dynamic task type selection based on memory strength
 * - Multiple study modes (recognition, recall, typing, listening, sentence)
 * - Real-time learning analytics
 * - Memory strength visualization
 * - Firebase sync for learning history
 */

import React, { useState, useEffect } from 'react';
import { StoredItem, TaskType, VocabCard, SearchResult } from '../types';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { 
  RecognitionTask, 
  RecallTask, 
  TypingTask, 
  ListeningTask, 
  SentenceTask 
} from '../components/StudyTasks';
import { Button } from '../components/Button';
import { 
  Trophy, 
  TrendingUp, 
  Flame, 
  BrainCircuit, 
  BarChart3,
  Zap,
  Target,
  Clock
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { saveLearningAnalytics, recordStudySession, LearningAnalytics } from '../services/firebase';

interface StudyEnhancedProps {
  items: StoredItem[];
  onUpdateSRS: (itemId: string, quality: number, taskType: TaskType, responseTime: number) => void;
  onSearch: (text: string) => void;
  onDelete: (id: string) => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  userId?: string; // For Firebase sync
}

type StudyMode = 'dashboard' | 'session' | 'complete';

export const StudyEnhanced: React.FC<StudyEnhancedProps> = ({ 
  items, 
  onUpdateSRS, 
  onSearch, 
  onDelete, 
  onScroll,
  userId 
}) => {
  const [mode, setMode] = useState<StudyMode>('dashboard');
  const [queue, setQueue] = useState<StoredItem[]>([]);
  const [sessionStartTime, setSessionStartTime] = useState(0);
  const [sessionStats, setSessionStats] = useState({
    reviews: 0,
    correct: 0,
    totalTime: 0
  });
  const [currentTaskType, setCurrentTaskType] = useState<TaskType>('recognition');

  // Calculate comprehensive statistics
  const getStats = () => {
    const now = Date.now();
    const due = items.filter(i => i.srs.nextReview <= now).length;
    
    // Memory strength based categories
    const grandmaster = items.filter(i => i.srs.memoryStrength >= 85).length;
    const mastered = items.filter(i => i.srs.memoryStrength >= 70 && i.srs.memoryStrength < 85).length;
    const learning = items.filter(i => i.srs.memoryStrength >= 30 && i.srs.memoryStrength < 70).length;
    const struggling = items.filter(i => i.srs.memoryStrength < 30).length;
    
    // Streak calculation
    const today = new Date().toISOString().split('T')[0];
    const hasStudiedToday = items.some(i => {
      const lastReview = new Date(i.srs.lastReviewDate).toISOString().split('T')[0];
      return lastReview === today;
    });
    
    // Average memory strength
    const avgStrength = items.length > 0 
      ? items.reduce((sum, i) => sum + i.srs.memoryStrength, 0) / items.length 
      : 0;

    return { 
      due, 
      grandmaster, 
      mastered, 
      learning, 
      struggling, 
      total: items.length,
      hasStudiedToday,
      avgStrength: Math.round(avgStrength)
    };
  };

  const stats = getStats();

  const startSession = () => {
    const now = Date.now();
    
    // 1. Get due items
    const dueItems = items
      .filter(item => item.srs.nextReview <= now)
      .sort((a, b) => {
        // Prioritize by retention probability (lowest first - most at risk of forgetting)
        const probA = SRSAlgorithm.getRetentionProbability(a.srs);
        const probB = SRSAlgorithm.getRetentionProbability(b.srs);
        return probA - probB;
      });
    
    let studySet = [...dueItems];

    // 2. Backfill with struggling items if needed
    if (studySet.length < 10) {
      const needed = 10 - studySet.length;
      const candidates = items
        .filter(item => !studySet.find(d => d.data.id === item.data.id))
        .sort((a, b) => a.srs.memoryStrength - b.srs.memoryStrength);
      
      studySet = [...studySet, ...candidates.slice(0, needed)];
    }

    if (studySet.length === 0) {
      alert("No items to review! Add more to your notebook.");
      return;
    }

    setQueue(studySet);
    setMode('session');
    setSessionStartTime(Date.now());
    setSessionStats({ reviews: 0, correct: 0, totalTime: 0 });
    
    // Determine task type for first item
    if (studySet[0]) {
      const taskType = SRSAlgorithm.recommendTaskType(studySet[0].srs);
      setCurrentTaskType(taskType);
    }
  };

  const handleComplete = (quality: number, responseTime: number) => {
    if (!queue[0]) return;

    const currentItem = queue[0];
    
    // Update SRS
    onUpdateSRS(currentItem.data.id, quality, currentTaskType, responseTime);

    // Update session stats
    setSessionStats(prev => ({
      reviews: prev.reviews + 1,
      correct: prev.correct + (quality >= 3 ? 1 : 0),
      totalTime: prev.totalTime + responseTime
    }));

    // Move to next item
    const nextQueue = queue.slice(1);
    
    if (nextQueue.length === 0) {
      // Session complete
      setMode('complete');
      confetti({
        particleCount: 150,
        spread: 80,
        origin: { y: 0.6 }
      });
      
      // Record session to Firebase
      if (userId) {
        const accuracy = sessionStats.reviews > 0 
          ? ((sessionStats.correct + (quality >= 3 ? 1 : 0)) / (sessionStats.reviews + 1)) * 100
          : 0;
        
        recordStudySession(userId, {
          reviews: sessionStats.reviews + 1,
          studyTime: Date.now() - sessionStartTime,
          accuracy
        });
      }
    } else {
      // Determine next task type
      const nextTaskType = SRSAlgorithm.recommendTaskType(nextQueue[0].srs);
      setCurrentTaskType(nextTaskType);
      setQueue(nextQueue);
    }
  };

  const handleSkip = () => {
    const nextQueue = queue.slice(1);
    if (nextQueue.length === 0) {
      setMode('dashboard');
    } else {
      const nextTaskType = SRSAlgorithm.recommendTaskType(nextQueue[0].srs);
      setCurrentTaskType(nextTaskType);
      setQueue(nextQueue);
    }
  };

  // Render task component based on type
  const renderTask = () => {
    if (!queue[0]) return null;
    
    const item = queue[0];
    
    // Only vocab items support all task types
    if (item.type !== 'vocab') {
      return (
        <div className="h-full flex items-center justify-center p-8">
          <p className="text-slate-500">Phrase items don't support interactive tasks yet.</p>
          <Button onClick={handleSkip} className="mt-4">Skip</Button>
        </div>
      );
    }

    const vocab = item.data as VocabCard;
    const commonProps = {
      vocab,
      onComplete: handleComplete,
      onSkip: handleSkip
    };

    switch (currentTaskType) {
      case 'recognition':
        return <RecognitionTask {...commonProps} />;
      case 'recall':
        return <RecallTask {...commonProps} />;
      case 'typing':
        return <TypingTask {...commonProps} />;
      case 'listening':
        return <ListeningTask {...commonProps} />;
      case 'sentence':
        return <SentenceTask {...commonProps} />;
      default:
        return <RecallTask {...commonProps} />;
    }
  };

  if (items.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-500 bg-slate-50">
        <div className="w-20 h-20 bg-slate-200 rounded-full flex items-center justify-center mb-4">
          <BrainCircuit size={40} className="text-slate-400" />
        </div>
        <h3 className="text-xl font-bold text-slate-700 mb-2">No Knowledge Yet</h3>
        <p className="max-w-xs">Add words to your notebook to start building your personalized AI curriculum.</p>
      </div>
    );
  }

  // --- DASHBOARD VIEW ---
  if (mode === 'dashboard') {
    return (
      <div className="h-full overflow-y-auto bg-slate-50 p-6 pb-[calc(5rem+env(safe-area-inset-bottom))]" onScroll={onScroll}>
        <h2 className="text-3xl font-bold text-slate-800 mb-1">Advanced Study</h2>
        <p className="text-slate-500 mb-8">Adaptive spaced-repetition with memory strength tracking</p>

        {/* Main Action Card */}
        <div className="bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-600 rounded-3xl p-6 shadow-xl mb-8 relative overflow-hidden text-white">
          <div className="relative z-10">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-5xl font-extrabold tracking-tighter">{stats.due}</span>
              <span className="text-violet-200 font-medium text-lg">due now</span>
            </div>
            <p className="text-sm text-violet-100 mb-8 font-medium max-w-[80%]">
              {stats.due > 0 
                ? "Your brain is ready to strengthen these memories!" 
                : stats.hasStudiedToday 
                  ? "Amazing! You've completed today's reviews." 
                  : "Start today's practice to maintain your streak!"}
            </p>
            <Button onClick={startSession} className="w-full py-4 text-lg bg-white text-violet-600 hover:bg-violet-50 border-0 font-bold shadow-lg">
              {stats.due > 0 ? "Begin Smart Review" : "Practice Mode"}
            </Button>
          </div>
          <div className="absolute -right-8 -top-8 w-40 h-40 bg-white opacity-10 rounded-full blur-2xl"></div>
          <div className="absolute -left-8 -bottom-8 w-40 h-40 bg-purple-400 opacity-20 rounded-full blur-2xl"></div>
        </div>

        {/* Overall Progress Bar */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Zap size={18} className="text-amber-500" fill="currentColor" />
              <span className="text-sm font-bold text-slate-700">Memory Strength</span>
            </div>
            <span className="text-2xl font-bold text-slate-800">{stats.avgStrength}%</span>
          </div>
          <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-amber-400 via-orange-500 to-rose-500 transition-all duration-500"
              style={{ width: `${stats.avgStrength}%` }}
            />
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Average retention strength across all items
          </p>
        </div>

        {/* Stats Grid */}
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 px-1">Mastery Levels</h3>
        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="bg-white p-5 rounded-2xl border border-purple-100 shadow-sm">
            <div className="w-10 h-10 bg-purple-50 text-purple-600 rounded-full flex items-center justify-center mb-3">
              <Trophy size={20} fill="currentColor" />
            </div>
            <span className="text-2xl font-bold text-slate-800 block">{stats.grandmaster}</span>
            <span className="text-xs text-slate-400 font-bold uppercase tracking-wide">Grandmaster</span>
            <div className="mt-2 h-1 bg-purple-100 rounded-full">
              <div className="h-full bg-purple-500 rounded-full" style={{ width: '100%' }} />
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-emerald-100 shadow-sm">
            <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mb-3">
              <Target size={20} />
            </div>
            <span className="text-2xl font-bold text-slate-800 block">{stats.mastered}</span>
            <span className="text-xs text-slate-400 font-bold uppercase tracking-wide">Mastered</span>
            <div className="mt-2 h-1 bg-emerald-100 rounded-full">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: '85%' }} />
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-blue-100 shadow-sm">
            <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mb-3">
              <TrendingUp size={20} />
            </div>
            <span className="text-2xl font-bold text-slate-800 block">{stats.learning}</span>
            <span className="text-xs text-slate-400 font-bold uppercase tracking-wide">Learning</span>
            <div className="mt-2 h-1 bg-blue-100 rounded-full">
              <div className="h-full bg-blue-500 rounded-full" style={{ width: '60%' }} />
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-orange-100 shadow-sm">
            <div className="w-10 h-10 bg-orange-50 text-orange-600 rounded-full flex items-center justify-center mb-3">
              <Flame size={20} />
            </div>
            <span className="text-2xl font-bold text-slate-800 block">{stats.struggling}</span>
            <span className="text-xs text-slate-400 font-bold uppercase tracking-wide">Needs Practice</span>
            <div className="mt-2 h-1 bg-orange-100 rounded-full">
              <div className="h-full bg-orange-500 rounded-full" style={{ width: '30%' }} />
            </div>
          </div>
        </div>

        {/* Session Stats (if available) */}
        {sessionStats.reviews > 0 && mode === 'dashboard' && (
          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 p-5 rounded-2xl border border-indigo-200 mb-6">
            <h3 className="text-sm font-bold text-indigo-700 mb-3 flex items-center gap-2">
              <BarChart3 size={16} />
              Last Session
            </h3>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-2xl font-bold text-slate-800">{sessionStats.reviews}</p>
                <p className="text-xs text-slate-500">Reviews</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-emerald-600">
                  {sessionStats.reviews > 0 ? Math.round((sessionStats.correct / sessionStats.reviews) * 100) : 0}%
                </p>
                <p className="text-xs text-slate-500">Accuracy</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-blue-600">
                  {Math.round(sessionStats.totalTime / 1000)}s
                </p>
                <p className="text-xs text-slate-500">Time</p>
              </div>
            </div>
          </div>
        )}
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
            You've strengthened {sessionStats.reviews} memories
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
      <div className="w-full max-w-md mx-auto h-full flex flex-col p-4">
        {/* Header */}
        <div className="flex justify-between items-center mb-4 shrink-0">
          <Button variant="ghost" size="sm" onClick={() => setMode('dashboard')} className="text-slate-400 hover:text-slate-600">
            &larr; End
          </Button>
          
          <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase bg-white px-3 py-1.5 rounded-full shadow-sm">
            <Clock size={14} />
            <span>{queue.length} left</span>
          </div>

          <div className="text-xs font-mono text-slate-400 bg-white px-3 py-1.5 rounded-full shadow-sm">
            {sessionStats.reviews > 0 ? `${Math.round((sessionStats.correct / sessionStats.reviews) * 100)}%` : '0%'}
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-2 bg-slate-200 rounded-full mb-4 overflow-hidden shrink-0">
          <div 
            className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-500 ease-out" 
            style={{ width: `${Math.max(5, ((sessionStats.reviews) / (sessionStats.reviews + queue.length)) * 100)}%` }} 
          />
        </div>

        {/* Task Type Indicator */}
        <div className="mb-4 shrink-0">
          <div className="inline-flex items-center gap-2 bg-gradient-to-r from-violet-100 to-indigo-100 text-violet-700 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wide shadow-sm">
            <BrainCircuit size={14} />
            {currentTaskType} Mode
          </div>
        </div>

        {/* Task Container */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {renderTask()}
        </div>
      </div>
    </div>
  );
};

