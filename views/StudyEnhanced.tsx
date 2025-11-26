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
import { PronunciationBlock } from '../components/PronunciationBlock';
import { VocabCardDisplay } from '../components/VocabCard';
import ReactMarkdown from 'react-markdown';
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
  Play,
  Search as SearchIcon,
  RefreshCw,
  ThumbsUp,
  ThumbsDown
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { recordStudySession } from '../services/firebase';
import { StudyCardSwiper } from '../components/StudyCardSwiper';

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
  const [isFlipped, setIsFlipped] = useState(false);
  const [cardStartTime, setCardStartTime] = useState(0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  
  const [sessionStats, setSessionStats] = useState({
    reviews: 0,
    correct: 0,
    totalTime: 0
  });

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

    // 2. Backfill with struggling items if needed (up to 10)
    if (studySet.length < 10) {
      const needed = 10 - studySet.length;
      const candidates = items
        .filter(item => !studySet.find(d => d.data.id === item.data.id))
        .sort((a, b) => a.srs.memoryStrength - b.srs.memoryStrength); // Weakest first
      
      studySet = [...studySet, ...candidates.slice(0, needed)];
    }

    if (studySet.length === 0) {
      alert("No items to review yet! Add vocabulary or phrases to your notebook to start studying.");
      return;
    }

    setQueue(studySet);
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
    if (!queue[0]) return;

    const currentItem = queue[0];
    const responseTime = Date.now() - cardStartTime;
    
    // Map binary choice to quality score
    // Memorized -> 5 (Perfect)
    // Not Memorized -> 1 (Hard Fail - keeping it > 0 to avoid total reset if just a slip, but 1 is strong penalty)
    const quality = isMemorized ? 5 : 1;

    // Update SRS
    // We use 'recognition' as the standard task type for flashcards
    onUpdateSRS(currentItem.data.id, quality, 'recognition', responseTime);

    // Update session stats
    setSessionStats(prev => ({
      reviews: prev.reviews + 1,
      correct: prev.correct + (isMemorized ? 1 : 0),
      totalTime: prev.totalTime + responseTime
    }));

    // Move to next item
    const nextQueue = queue.slice(1);
    
    // Re-queue if failed (so we see it again this session)
    if (!isMemorized) {
       nextQueue.push(currentItem);
    }
    
    if (nextQueue.length === 0) {
      finishSession();
    } else {
      setQueue(nextQueue);
      setIsFlipped(false);
      setCardStartTime(Date.now());
    }
  }, [queue, cardStartTime, onUpdateSRS, finishSession]);

  useEffect(() => {
    if (mode !== 'session') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        handleRate(false);
      } else if (e.key === 'ArrowRight') {
        handleRate(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, handleRate]);

  const handleDeleteCurrent = () => {
    if (!queue[0]) return;
    
    // Delete from global storage
    onDelete(queue[0].data.id);
    
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
      setCardStartTime(Date.now());
    }
  };

  const renderFront = () => {
    if (!queue[0]) return null;
    const item = queue[0];
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
          <p className="text-[10px] font-bold text-indigo-400 tracking-widest uppercase opacity-60 group-hover:opacity-100 transition-opacity">Tap to reveal answer</p>
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
    if (!queue[0]) return null;
    const item = queue[0];
    
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
                    <img src={data.imageUrl} alt="Visual context" className="w-full h-full object-cover" />
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

        {/* Session Stats (only show after completing a session) */}
        {sessionStats.reviews > 0 && (
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
                  {Math.round((sessionStats.correct / sessionStats.reviews) * 100)}%
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
            <span>{queue.length} left</span>
          </div>

          <div className="flex items-center gap-2">
            <div className="text-xs font-mono text-slate-400 bg-white px-3 py-1.5 rounded-full shadow-sm">
              {sessionStats.reviews > 0 ? `${Math.round((sessionStats.correct / sessionStats.reviews) * 100)}%` : '0%'}
            </div>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => setShowDeleteConfirm(true)} 
              className="text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-full px-2"
              title="Delete from Notebook"
            >
              <Trash2 size={18} />
            </Button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-2 bg-slate-200 rounded-full mb-6 overflow-hidden shrink-0">
          <div 
            className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-500 ease-out" 
            style={{ width: `${(sessionStats.reviews + queue.length) > 0 ? Math.max(5, ((sessionStats.reviews) / (sessionStats.reviews + queue.length)) * 100) : 5}%` }} 
          />
        </div>

        {/* Card Container */}
        <div className="flex-1 relative perspective-1000 group w-full min-h-0 mb-1">
          <StudyCardSwiper 
             onSwipe={(direction) => handleRate(direction === 'right')} 
             enabled={true}
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
          </StudyCardSwiper>
        </div>

        {/* Action Buttons */}
        <div className="grid grid-cols-2 gap-1 shrink-0 h-8">
           <button 
             onClick={() => handleRate(false)}
             className="bg-rose-500 active:bg-rose-600 text-white rounded-lg font-bold text-xs shadow-sm shadow-rose-200 transition-all active:scale-95 flex items-center justify-center gap-1 p-0"
           >
             <ThumbsDown size={14} strokeWidth={2.5} />
             <span className="hidden sm:inline">Not Memorized</span>
           </button>
           <button 
             onClick={() => handleRate(true)}
             className="bg-emerald-500 active:bg-emerald-600 text-white rounded-lg font-bold text-xs shadow-sm shadow-emerald-200 transition-all active:scale-95 flex items-center justify-center gap-1 p-0"
           >
             <ThumbsUp size={14} strokeWidth={2.5} />
             <span className="hidden sm:inline">Memorized</span>
           </button>
        </div>

      </div>
      
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/20 backdrop-blur-[2px] flex items-center justify-center p-6 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-6 text-center animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
                <div className="w-12 h-12 bg-rose-100 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Trash2 size={24} />
                </div>
                <h3 className="text-lg font-bold text-slate-800 mb-2">Delete Item?</h3>
                <p className="text-sm text-slate-500 mb-6">
                    This will permanently remove this item from your notebook and study queue.
                </p>
                <div className="flex gap-3">
                    <Button variant="ghost" onClick={() => setShowDeleteConfirm(false)} className="flex-1">
                        Cancel
                    </Button>
                    <Button 
                        variant="primary" 
                        onClick={() => {
                            handleDeleteCurrent();
                            setShowDeleteConfirm(false);
                        }} 
                        className="flex-1 bg-rose-500 hover:bg-rose-600 shadow-rose-200 border-0"
                    >
                        Delete
                    </Button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};
