
import React, { useState, useEffect } from 'react';
import { StoredItem, SRSData } from '../types';
import { VocabCardDisplay } from '../components/VocabCard';
import { Volume2, RefreshCw, CheckCircle, Clock, Trophy, BrainCircuit, Star, TrendingUp, AlertCircle, Flame, Trash2 } from 'lucide-react';
import { Button } from '../components/Button';
import { AudioButton } from '../components/AudioButton';
import confetti from 'canvas-confetti'; 

interface StudyProps {
  items: StoredItem[];
  onUpdateSRS: (itemId: string, quality: number) => void; // quality: 0 (Soon), 3 (Good), 5 (Easy)
  onSearch: (text: string) => void;
  onDelete: (id: string) => void;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

type StudyMode = 'dashboard' | 'session' | 'complete';

export const StudyView: React.FC<StudyProps> = ({ items, onUpdateSRS, onSearch, onDelete, onScroll }) => {
  const [mode, setMode] = useState<StudyMode>('dashboard');
  const [queue, setQueue] = useState<StoredItem[]>([]);
  const [isFlipped, setIsFlipped] = useState(false);
  
  // Statistics Calculation
  const getStats = () => {
      const now = Date.now();
      const due = items.filter(i => i.srs.nextReview <= now).length;
      
      // Mastery definition: Interval > 21 days (3 weeks)
      const mastered = items.filter(i => i.srs.interval > 21 * 24 * 60).length;
      
      // Struggling: Ease Factor < 2.0 (Default is 2.5)
      const struggling = items.filter(i => i.srs.easeFactor < 2.0).length;
      
      // Learning: Not new (has history), not mastered
      const learning = items.filter(i => i.srs.history.length > 0 && i.srs.interval <= 21 * 24 * 60).length;

      return { due, mastered, struggling, learning, total: items.length };
  };

  const stats = getStats();

  const startSession = () => {
    const now = Date.now();
    // 1. Priority: Due Items
    const dueItems = items
      .filter(item => item.srs.nextReview <= now)
      .sort((a, b) => a.srs.nextReview - b.srs.nextReview);
    
    let studySet = [...dueItems];

    // 2. Backfill: If due list is small (< 5), add "Struggling" or "New" items
    if (studySet.length < 10 && items.length > studySet.length) {
         const needed = 10 - studySet.length;
         
         // Find items that are NOT already in the due list
         const candidates = items.filter(item => !studySet.find(d => d.data.id === item.data.id));
         
         // Sort candidates: 
         // Priority A: Low Ease Factor (Struggling)
         // Priority B: Short History (Newish)
         // Priority C: Random
         const backfill = candidates.sort((a, b) => {
             if (a.srs.easeFactor !== b.srs.easeFactor) {
                 return a.srs.easeFactor - b.srs.easeFactor; // Ascending (hardest first)
             }
             return Math.random() - 0.5;
         }).slice(0, needed);
         
         studySet = [...studySet, ...backfill];
    }

    if (studySet.length === 0) {
        alert("No items to review! Add more to your notebook.");
        return;
    }

    setQueue(studySet);
    setIsFlipped(false);
    setMode('session');
  };

  const currentItem = queue[0];

  const handleRate = (quality: number) => {
    if (!currentItem) return;

    // Update global storage
    onUpdateSRS(currentItem.data.id, quality);

    setIsFlipped(false);

    if (quality === 0) {
      // "Soon" - Requeue at end of session
      setQueue(prev => {
        const [, ...rest] = prev;
        return [...rest, currentItem];
      });
    } else {
      // Remove from queue
      setQueue(prev => {
        const [, ...rest] = prev;
        if (rest.length === 0) {
           setMode('complete');
           confetti({
             particleCount: 100,
             spread: 70,
             origin: { y: 0.6 }
           });
        }
        return rest;
      });
    }
  };

  const handleDeleteCurrent = () => {
      if (!currentItem) return;

      // 1. Delete from global storage
      onDelete(currentItem.data.id);

      // 2. Remove from local session queue
      setQueue(prev => {
          const remaining = prev.filter(i => i.data.id !== currentItem.data.id);
          if (remaining.length === 0) {
              setMode('dashboard');
          }
          return remaining;
      });
      
      setIsFlipped(false);
  };

  // Helper to get mastery level for badges
  const getMasteryLevel = (item: StoredItem) => {
      const intervalDays = item.srs.interval / (24 * 60);
      if (intervalDays > 60) return { label: 'Grandmaster', color: 'bg-purple-100 text-purple-700', icon: Trophy };
      if (intervalDays > 21) return { label: 'Mastered', color: 'bg-emerald-100 text-emerald-700', icon: Star };
      if (item.srs.history.length > 3) return { label: 'Learning', color: 'bg-blue-100 text-blue-700', icon: TrendingUp };
      if (item.srs.easeFactor < 2.0) return { label: 'Hard', color: 'bg-orange-100 text-orange-700', icon: AlertCircle };
      return { label: 'New', color: 'bg-slate-100 text-slate-600', icon: BrainCircuit };
  };

  // Helper for dynamic font sizing
  const getTextSize = (len: number) => {
      if (len > 300) return 'text-xs';
      if (len > 150) return 'text-sm';
      if (len > 80) return 'text-base';
      if (len > 40) return 'text-xl';
      return 'text-3xl';
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
      )
  }

  // --- DASHBOARD VIEW ---
  if (mode === 'dashboard') {
      return (
        <div className="h-full overflow-y-auto bg-slate-50 p-6 pb-[calc(5rem+env(safe-area-inset-bottom))]" onScroll={onScroll}>
            <h2 className="text-3xl font-bold text-slate-800 mb-1">Study Center</h2>
            <p className="text-slate-500 mb-8">Your personalized spaced-repetition queue.</p>

            {/* Main Action Card */}
            <div className="bg-gradient-to-br from-indigo-600 to-violet-600 rounded-3xl p-6 shadow-xl shadow-indigo-200 mb-8 relative overflow-hidden text-white">
                <div className="relative z-10">
                    <div className="flex items-baseline gap-2 mb-2">
                        <span className="text-5xl font-extrabold tracking-tighter">{stats.due}</span>
                        <span className="text-indigo-200 font-medium text-lg">items due</span>
                    </div>
                    <p className="text-sm text-indigo-100 mb-8 font-medium max-w-[80%]">
                        {stats.due > 0 ? "Time to review! Keep your memory fresh." : "You're all caught up! Great job."}
                    </p>
                    <Button onClick={startSession} className="w-full py-4 text-lg bg-white text-indigo-600 hover:bg-indigo-50 border-0 font-bold shadow-lg">
                        {stats.due > 0 ? "Start Review Session" : "Practice Anyway"}
                    </Button>
                </div>
                {/* Decorative BG */}
                <div className="absolute -right-8 -top-8 w-40 h-40 bg-white opacity-10 rounded-full blur-2xl"></div>
                <div className="absolute -left-8 -bottom-8 w-40 h-40 bg-indigo-400 opacity-20 rounded-full blur-2xl"></div>
            </div>

            {/* Stats Grid */}
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 px-1">Your Progress</h3>
            <div className="grid grid-cols-2 gap-3">
                <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-between h-32">
                    <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center">
                        <Trophy size={20} fill="currentColor" className="opacity-80" />
                    </div>
                    <div>
                        <span className="text-2xl font-bold text-slate-800 block">{stats.mastered}</span>
                        <span className="text-xs text-slate-400 font-bold uppercase tracking-wide">Mastered</span>
                    </div>
                </div>

                <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-between h-32">
                    <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center">
                        <TrendingUp size={20} />
                    </div>
                    <div>
                        <span className="text-2xl font-bold text-slate-800 block">{stats.learning}</span>
                        <span className="text-xs text-slate-400 font-bold uppercase tracking-wide">Learning</span>
                    </div>
                </div>

                <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-between col-span-2">
                    <div className="flex flex-col">
                         <span className="text-xs text-slate-400 font-bold uppercase tracking-wide mb-1">Needs Review</span>
                         <span className="text-2xl font-bold text-slate-800">{stats.struggling}</span>
                    </div>
                    <div className="w-12 h-12 bg-orange-50 text-orange-500 rounded-full flex items-center justify-center">
                         <AlertCircle size={24} />
                    </div>
                </div>
            </div>
        </div>
      );
  }

  // --- COMPLETE VIEW ---
  if (mode === 'complete') {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 bg-indigo-600 text-white relative overflow-hidden fade-in">
        <div className="z-10 text-center">
            <div className="mb-6 animate-bounce-slow">
                 <Trophy size={80} className="mx-auto text-yellow-300 drop-shadow-lg" fill="currentColor" />
            </div>
            <h2 className="text-4xl font-bold mb-3 tracking-tight">Session Complete!</h2>
            <p className="text-indigo-200 mb-10 text-lg max-w-xs mx-auto leading-relaxed">
                You've reviewed all your cards for now. Excellent work!
            </p>
            <div className="flex flex-col gap-3 w-full max-w-xs">
                <Button variant="primary" onClick={() => setMode('dashboard')} className="bg-white text-indigo-600 hover:bg-indigo-50 border-0 font-bold py-4">
                    Back to Dashboard
                </Button>
                <Button variant="ghost" onClick={startSession} className="text-indigo-200 hover:text-white hover:bg-indigo-500/30">
                    Review Again
                </Button>
            </div>
        </div>
        
        {/* Background decorations */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
            <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-500 rounded-full blur-[100px] opacity-50"></div>
            <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-purple-500 rounded-full blur-[100px] opacity-50"></div>
        </div>
      </div>
    );
  }

  // --- SESSION VIEW (FULL SCREEN OVERLAY) ---
  if (!currentItem) return null;

  // Data Prep
  const isPhrase = currentItem.type === 'phrase';
  const frontText = isPhrase ? (currentItem.data as any).query : (currentItem.data as any).word;
  const frontSub = isPhrase ? 'Phrase' : (currentItem.data as any).ipa;
  const mastery = getMasteryLevel(currentItem);
  const MasteryIcon = mastery.icon;

  return (
    <div className="fixed inset-0 z-50 bg-slate-100 flex flex-col animate-in slide-in-from-bottom duration-300">
      <div className="w-full max-w-md mx-auto h-full flex flex-col p-4">
        {/* Header */}
        <div className="flex justify-between items-center mb-4 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setMode('dashboard')} className="text-slate-400 hover:text-slate-600">
                &larr; End
            </Button>
            
            <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase bg-white px-3 py-1 rounded-full shadow-sm">
                <span>{queue.length} Remaining</span>
            </div>

            <Button variant="ghost" size="sm" onClick={handleDeleteCurrent} className="text-slate-400 hover:text-red-500" title="Remove from Study">
               <Trash2 size={18} />
            </Button>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-1.5 bg-slate-200 rounded-full mb-6 overflow-hidden shrink-0">
          <div 
              className="h-full bg-indigo-500 transition-all duration-500 ease-out" 
              style={{ width: `${Math.max(5, 100 - (queue.length * 5))}%` }} 
          />
        </div>

        {/* Flashcard Container */}
        <div className="flex-1 relative perspective-1000 group w-full min-h-0 mb-6">
          <div 
              className={`relative w-full h-full transition-all duration-500 transform-style-3d ${isFlipped ? 'rotate-y-180' : ''}`}
          >
              {/* FRONT */}
              <div className={`absolute inset-0 backface-hidden transition-opacity duration-75 delay-200 ${isFlipped ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                  <div className="w-full h-full bg-white rounded-[2rem] shadow-xl shadow-slate-200/60 border border-slate-100 flex flex-col justify-between p-8 cursor-pointer hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 relative overflow-hidden"
                      onClick={() => setIsFlipped(true)}
                  >
                      
                      {/* Top: Badge & Prompt */}
                      <div className="relative w-full h-8 shrink-0 flex justify-center">
                          <p className="text-[10px] font-bold text-indigo-400 tracking-widest uppercase mt-1 opacity-60">Tap to reveal</p>
                          <div className={`absolute top-0 right-0 px-2.5 py-1 rounded-full text-[10px] font-bold flex items-center gap-1.5 ${mastery.color}`}>
                              <MasteryIcon size={12} /> {mastery.label}
                          </div>
                      </div>

                      {/* Middle: Content */}
                      <div className="flex-1 flex items-center justify-center w-full overflow-hidden my-4">
                          <div className="max-h-full w-full overflow-y-auto no-scrollbar text-center px-2">
                              <h2 className={`font-bold text-slate-800 break-words leading-tight tracking-tight ${getTextSize(frontText.length)}`}>
                                  {frontText}
                              </h2>
                          </div>
                      </div>

                      {/* Bottom: Meta & Audio */}
                      <div className="shrink-0 flex flex-col items-center gap-6 pb-4">
                          {frontSub && <p className="text-base text-slate-400 font-mono bg-slate-50 px-3 py-1 rounded-lg">{frontSub}</p>}
                          <AudioButton 
                              text={frontText}
                              className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center text-indigo-600 hover:bg-indigo-600 hover:text-white transition-all active:scale-90 shadow-sm hover:shadow-md"
                              iconSize={28}
                              onClick={(e) => e.stopPropagation()}
                          />
                      </div>
                  </div>
              </div>

              {/* BACK */}
              <div className={`absolute inset-0 rotate-y-180 backface-hidden transition-opacity duration-75 delay-200 ${isFlipped ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                  <div className="w-full h-full bg-white rounded-[2rem] shadow-xl border border-slate-100 overflow-hidden relative">
                       {currentItem.type === 'vocab' ? (
                           <VocabCardDisplay 
                              data={currentItem.data as any} 
                              showSave={false} 
                              className="h-full w-full rounded-[2rem] border-0 shadow-none" 
                              onSearch={onSearch}
                              showAudio={false}
                              showPronunciation={false}
                           />
                       ) : (
                           <div className="h-full p-8 flex flex-col justify-center overflow-y-auto text-center">
                               <h3 className="text-2xl font-bold text-slate-800 mb-6 leading-snug">{(currentItem.data as any).translation}</h3>
                               
                               <div className="w-16 h-1 bg-indigo-100 mx-auto mb-8 rounded-full"></div>

                               <div className="prose prose-sm prose-indigo max-w-none text-slate-600">
                                  <p className="font-mono text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg inline-block mb-6 font-medium">
                                    /{(currentItem.data as any).pronunciation}/
                                  </p>
                                  
                                  {(currentItem.data as any).visualKeyword && (
                                    <div className="mt-4 p-5 bg-gradient-to-br from-slate-50 to-indigo-50/50 rounded-2xl border border-slate-100 text-sm text-slate-700">
                                        <span className="block mb-2 text-[10px] font-bold uppercase text-indigo-400 tracking-widest">Core Concept</span>
                                        {(currentItem.data as any).visualKeyword}
                                    </div>
                                  )}
                               </div>
                           </div>
                       )}
                  </div>
              </div>
          </div>
        </div>

        {/* Controls - Traffic Light System */}
        <div className={`flex gap-3 transition-all duration-300 shrink-0 pb-4 ${isFlipped ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
            <button 
              onClick={() => handleRate(0)}
              className="flex-1 flex flex-col items-center gap-1 py-4 bg-rose-100 text-rose-700 rounded-2xl font-bold active:scale-95 transition-all shadow-sm hover:bg-rose-200 border-b-4 border-rose-200 active:border-b-0 active:translate-y-1"
            >
              <span className="text-xs uppercase tracking-widest opacity-70">Forgot</span>
              <span className="text-lg">Again</span>
            </button>
            
            <button 
              onClick={() => handleRate(3)}
              className="flex-1 flex flex-col items-center gap-1 py-4 bg-amber-100 text-amber-700 rounded-2xl font-bold active:scale-95 transition-all shadow-sm hover:bg-amber-200 border-b-4 border-amber-200 active:border-b-0 active:translate-y-1"
            >
              <span className="text-xs uppercase tracking-widest opacity-70">Hard</span>
              <span className="text-lg">Good</span>
            </button>

            <button 
              onClick={() => handleRate(5)}
              className="flex-1 flex flex-col items-center gap-1 py-4 bg-emerald-100 text-emerald-700 rounded-2xl font-bold active:scale-95 transition-all shadow-sm hover:bg-emerald-200 border-b-4 border-emerald-200 active:border-b-0 active:translate-y-1"
            >
              <span className="text-xs uppercase tracking-widest opacity-70">Easy</span>
              <span className="text-lg">Easy</span>
            </button>
        </div>
      </div>
    </div>
  );
};
