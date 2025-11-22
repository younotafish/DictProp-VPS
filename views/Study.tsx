
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
}

type StudyMode = 'dashboard' | 'session' | 'complete';

export const StudyView: React.FC<StudyProps> = ({ items, onUpdateSRS, onSearch, onDelete }) => {
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
        <div className="h-full overflow-y-auto bg-slate-50 p-6 pb-24">
            <h2 className="text-3xl font-bold text-slate-800 mb-1">Study Center</h2>
            <p className="text-slate-500 mb-8">Your personalized spaced-repetition queue.</p>

            {/* Main Action Card */}
            <div className="bg-white rounded-3xl p-6 shadow-lg shadow-indigo-100 border border-indigo-50 mb-8 relative overflow-hidden">
                <div className="relative z-10">
                    <div className="flex items-baseline gap-1 mb-1">
                        <span className="text-4xl font-extrabold text-indigo-600">{stats.due}</span>
                        <span className="text-slate-500 font-medium">items due</span>
                    </div>
                    <p className="text-sm text-slate-400 mb-6">
                        {stats.due > 0 ? "Review these now to keep your streak!" : "You're all caught up! Practice extra?"}
                    </p>
                    <Button onClick={startSession} className="w-full py-4 text-lg shadow-indigo-200 shadow-xl">
                        {stats.due > 0 ? "Start Review Session" : "Start Practice Session"}
                    </Button>
                </div>
                {/* Decorative BG */}
                <div className="absolute -right-8 -top-8 w-32 h-32 bg-indigo-50 rounded-full opacity-50 blur-2xl"></div>
                <div className="absolute -left-8 -bottom-8 w-32 h-32 bg-purple-50 rounded-full opacity-50 blur-2xl"></div>
            </div>

            {/* Stats Grid */}
            <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4 px-1">Progress Overview</h3>
            <div className="grid grid-cols-2 gap-4">
                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex flex-col items-center text-center">
                    <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-3">
                        <Star size={20} fill="currentColor" />
                    </div>
                    <span className="text-2xl font-bold text-slate-800">{stats.mastered}</span>
                    <span className="text-xs text-slate-400 font-medium uppercase">Mastered</span>
                </div>

                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex flex-col items-center text-center">
                    <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mb-3">
                        <TrendingUp size={20} />
                    </div>
                    <span className="text-2xl font-bold text-slate-800">{stats.learning}</span>
                    <span className="text-xs text-slate-400 font-medium uppercase">Learning</span>
                </div>

                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex flex-col items-center text-center col-span-2 flex-row justify-between px-6">
                    <div className="flex flex-col text-left">
                        <span className="text-2xl font-bold text-slate-800">{stats.struggling}</span>
                        <span className="text-xs text-slate-400 font-medium uppercase">Needs Attention</span>
                    </div>
                    <div className="w-12 h-12 bg-orange-100 text-orange-500 rounded-full flex items-center justify-center">
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
        <div className="z-10 text-center animate-bounce-slow">
            <Trophy size={64} className="mx-auto mb-6 text-yellow-300" />
            <h2 className="text-3xl font-bold mb-2">Session Complete!</h2>
            <p className="text-indigo-200 mb-8">You've reviewed all queued items.</p>
            <div className="flex gap-4 justify-center">
                <Button variant="secondary" onClick={() => setMode('dashboard')}>
                    Dashboard
                </Button>
                <Button variant="primary" onClick={startSession} className="bg-indigo-500 hover:bg-indigo-400 shadow-none border border-indigo-400">
                    Review Again
                </Button>
            </div>
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
            
            <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase">
                <span>{queue.length} Left</span>
            </div>

            <Button variant="ghost" size="sm" onClick={handleDeleteCurrent} className="text-slate-400 hover:text-red-500" title="Remove from Study">
               <Trash2 size={18} />
            </Button>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-1.5 bg-slate-200 rounded-full mb-4 overflow-hidden shrink-0">
          <div 
              className="h-full bg-indigo-500 transition-all duration-500" 
              style={{ width: `${Math.max(5, 100 - (queue.length * 5))}%` }} 
          />
        </div>

        {/* Flashcard Container */}
        <div className="flex-1 relative perspective-1000 group w-full min-h-0 mb-6">
          <div 
              className={`relative w-full h-full transition-all duration-700 transform-style-3d ${isFlipped ? 'rotate-y-180' : ''}`}
              onClick={() => setIsFlipped(prev => !prev)}
          >
              {/* FRONT */}
              <div className="absolute inset-0 backface-hidden">
                  <div className="w-full h-full bg-white rounded-3xl shadow-xl border border-slate-200 flex flex-col justify-between p-6 cursor-pointer hover:shadow-2xl transition-shadow relative overflow-hidden">
                      
                      {/* Top: Badge & Prompt */}
                      <div className="relative w-full h-8 shrink-0 flex justify-center">
                          <p className="text-[10px] font-bold text-indigo-500 tracking-widest uppercase mt-1 opacity-50">Tap to flip</p>
                          <div className={`absolute top-0 right-0 px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 ${mastery.color}`}>
                              <MasteryIcon size={10} /> {mastery.label}
                          </div>
                      </div>

                      {/* Middle: Content */}
                      <div className="flex-1 flex items-center justify-center w-full overflow-hidden my-2">
                          <div className="max-h-full w-full overflow-y-auto no-scrollbar text-center px-2">
                              <h2 className={`font-bold text-slate-800 break-words leading-snug ${getTextSize(frontText.length)}`}>
                                  {frontText}
                              </h2>
                          </div>
                      </div>

                      {/* Bottom: Meta & Audio */}
                      <div className="shrink-0 flex flex-col items-center gap-4 pb-2">
                          {frontSub && <p className="text-sm text-slate-400 font-mono truncate max-w-[90%]">{frontSub}</p>}
                          <AudioButton 
                              text={frontText}
                              className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center text-indigo-600 hover:bg-indigo-600 hover:text-white transition-all active:scale-90 shadow-sm"
                              iconSize={32}
                              onClick={(e) => e.stopPropagation()}
                          />
                      </div>
                  </div>
              </div>

              {/* BACK */}
              <div className="absolute inset-0 rotate-y-180 backface-hidden">
                  <div className="w-full h-full bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden relative">
                       {currentItem.type === 'vocab' ? (
                           <VocabCardDisplay 
                              data={currentItem.data as any} 
                              showSave={false} 
                              className="h-full w-full rounded-3xl border-0 shadow-none" 
                              onSearch={onSearch}
                           />
                       ) : (
                           <div className="h-full p-8 flex flex-col justify-center overflow-y-auto text-center">
                               <h3 className="text-2xl font-bold text-slate-800 mb-4 leading-snug">{(currentItem.data as any).translation}</h3>
                               
                               <div className="w-12 h-1 bg-indigo-100 mx-auto mb-6 rounded-full"></div>

                               <div className="prose prose-sm prose-indigo max-w-none text-slate-600">
                                  <p className="font-mono text-slate-500 mb-6 bg-slate-50 p-2 rounded-lg inline-block">{(currentItem.data as any).pronunciation}</p>
                                  
                                  {(currentItem.data as any).visualKeyword && (
                                    <div className="mt-2 p-4 bg-indigo-50 rounded-2xl border border-indigo-100 text-sm text-indigo-900">
                                        <span className="block mb-1 text-[10px] font-bold uppercase text-indigo-400 tracking-widest">Concept</span>
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

        {/* Controls */}
        <div className={`flex gap-3 transition-all duration-300 shrink-0 pb-2 ${isFlipped ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
            <button 
              onClick={() => handleRate(0)}
              className="flex-1 flex flex-col items-center gap-1 py-3 bg-orange-100 text-orange-800 rounded-2xl font-bold active:scale-95 transition-transform shadow-sm hover:bg-orange-200"
            >
              <Clock size={20} className="mb-1" />
              <span className="text-[10px] uppercase tracking-wide">Soon</span>
            </button>
            
            <button 
              onClick={() => handleRate(3)}
              className="flex-1 flex flex-col items-center gap-1 py-3 bg-slate-200 text-slate-700 rounded-2xl font-bold active:scale-95 transition-transform shadow-sm hover:bg-slate-300"
            >
              <Flame size={20} className="mb-1" />
              <span className="text-[10px] uppercase tracking-wide">Hard</span>
            </button>

            <button 
              onClick={() => handleRate(5)}
              className="flex-1 flex flex-col items-center gap-1 py-3 bg-emerald-100 text-emerald-800 rounded-2xl font-bold active:scale-95 transition-transform shadow-sm hover:bg-emerald-200"
            >
              <CheckCircle size={20} className="mb-1" />
              <span className="text-[10px] uppercase tracking-wide">Easy</span>
            </button>
        </div>
      </div>
    </div>
  );
};
