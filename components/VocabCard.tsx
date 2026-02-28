import React, { memo, useState, useCallback } from 'react';
import { VocabCard as VocabType, WordFamilyEntry } from '../types';
import { Sparkles, BookOpen, History, Lightbulb, Maximize2, RefreshCw, Shapes, Network, Scale, Check, X, BookmarkPlus, BookmarkCheck } from 'lucide-react';
import { Button } from './Button';
import { PronunciationBlock } from './PronunciationBlock';
import { OfflineImage } from './OfflineImage';

interface Props {
  data: VocabType;
  onSave?: () => void;
  isSaved?: boolean;
  className?: string;
  showSave?: boolean;
  onSearch?: (term: string) => void;
  onExpand?: () => void;
  scrollable?: boolean;
  showAudio?: boolean;
  showPronunciation?: boolean;
  showRefresh?: boolean;
  onCompare?: (words: string[]) => void;
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
}

// Memoize to prevent re-renders when other cards in the list update
export const VocabCardDisplay: React.FC<Props> = memo(({ 
  data, 
  onSave, 
  isSaved = false, 
  className = '',
  showSave = true,
  onSearch,
  onExpand,
  scrollable = true,
  showAudio = true,
  showPronunciation = true,
  showRefresh = true,
  onCompare,
  onSaveSentence,
  isSentenceSaved,
}) => {
  
  // Compare-pick mode state
  const [comparePicking, setComparePicking] = useState<'synonyms' | 'confusables' | null>(null);
  const [compareSelected, setCompareSelected] = useState<Set<string>>(new Set());

  // Reset compare-pick state when the card changes (e.g., navigating in DetailView)
  React.useEffect(() => {
    setComparePicking(null);
    setCompareSelected(new Set());
  }, [data.id]);

  // Robust helper to ensure we always map over an array
  const ensureArray = (items: any): string[] => {
    if (Array.isArray(items)) return items;
    if (typeof items === 'string') return [items];
    return [];
  };

  const toggleCompareSelection = useCallback((word: string) => {
    setCompareSelected(prev => {
      const next = new Set(prev);
      if (next.has(word)) {
        next.delete(word);
      } else if (next.size < 2) { // Max 2 picks + current word = 3 total
        next.add(word);
      }
      return next;
    });
  }, []);

  const startComparePick = useCallback((section: 'synonyms' | 'confusables') => {
    setComparePicking(section);
    setCompareSelected(new Set());
  }, []);

  const cancelComparePick = useCallback(() => {
    setComparePicking(null);
    setCompareSelected(new Set());
  }, []);

  const executeCompare = useCallback(() => {
    if (onCompare && compareSelected.size >= 1) {
      const words = [data.word, ...Array.from(compareSelected)];
      onCompare(words);
      setComparePicking(null);
      setCompareSelected(new Set());
    }
  }, [onCompare, compareSelected, data.word]);

  const renderPills = (items: any, isPickMode: boolean = false) => ensureArray(items).map((item, idx) => {
    if (isPickMode) {
      const isSelected = compareSelected.has(item);
      return (
        <button
          key={`${item}-${idx}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleCompareSelection(item);
          }}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded mr-1 mb-1 transition-colors cursor-pointer text-left border ${
            isSelected
              ? 'bg-indigo-100 text-indigo-700 border-indigo-300'
              : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-indigo-50 hover:border-indigo-200'
          }`}
        >
          {isSelected && <Check size={12} className="shrink-0" />}
          {item}
        </button>
      );
    }
    return (
      <button 
        key={`${item}-${idx}`}
        onClick={(e) => {
          e.stopPropagation();
          onSearch?.(item);
        }}
        className="inline-block bg-slate-100 text-slate-600 px-2 py-0.5 rounded mr-1 mb-1 hover:bg-indigo-100 hover:text-indigo-700 transition-colors cursor-pointer text-left"
      >
        {item}
      </button>
    );
  });

  return (
    <div 
      className={`bg-white rounded-2xl p-5 pb-20 shadow-md border border-slate-100 flex flex-col select-text ${scrollable ? 'overflow-y-auto' : 'overflow-hidden'} ${className}`}
      style={{ WebkitUserSelect: 'text', userSelect: 'text' }}
    >
      {/* Header */}
      <div className="flex justify-between items-start mb-3 shrink-0">
        <div>
          <h3 className="text-2xl font-bold text-slate-800 tracking-tight">{data.word || ''}</h3>
          {/* Sense/Meaning Label */}
          {data.sense && (
            <span className="inline-block mt-1 px-2 py-0.5 bg-violet-100 text-violet-700 text-xs font-medium rounded-full">
              {data.sense}
            </span>
          )}
          {showPronunciation && (
          <div className="flex items-center gap-2 mt-1 text-slate-500">
            {showAudio && data.ipa && (
              <PronunciationBlock 
                text={data.word} 
                ipa={data.ipa} 
                className="text-sm bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
              />
            )}
          </div>
          )}
        </div>
        <div className="flex items-center gap-1">
            {showRefresh && onSearch && (
                 <Button
                    variant="icon"
                    onClick={(e) => { e.stopPropagation(); onSearch(data.word); }}
                    title="Refresh / Search Again"
                 >
                    <RefreshCw size={18} className="text-slate-400 hover:text-indigo-600" />
                 </Button>
            )}
            {onExpand && (
                <Button 
                    variant="icon" 
                    onClick={(e) => { e.stopPropagation(); onExpand(); }}
                    title="View Details"
                >
                    <Maximize2 size={20} className="text-slate-400 hover:text-indigo-600" />
                </Button>
            )}
            {showSave && onSave && (
            <Button 
                variant="icon" 
                onClick={(e) => { e.stopPropagation(); onSave(); }}
                className={isSaved ? "text-indigo-600 bg-indigo-50" : ""}
            >
                <Sparkles size={20} fill={isSaved ? "currentColor" : "none"} />
            </Button>
            )}
        </div>
      </div>

      {/* Generated Image */}
      {data.imageUrl && (
        <div className="mb-4 rounded-xl overflow-hidden w-full bg-slate-50 border border-slate-100 shadow-inner shrink-0">
          <OfflineImage src={data.imageUrl} alt={data.word} className="w-full fade-in" />
        </div>
      )}

      {/* Core Meaning */}
      <div className="mb-4 shrink-0" style={{ WebkitUserSelect: 'text', userSelect: 'text' }}>
        <p className="text-xl text-slate-700 font-medium leading-relaxed select-text">{data.chinese}</p>
        <p className="text-slate-500 mt-1 italic leading-relaxed select-text">{data.definition}</p>
      </div>

      {/* Word Forms */}
      {ensureArray(data.forms).length > 0 && (
        <div className="mb-4 shrink-0">
          <div className="flex items-center gap-2 text-xs font-bold text-indigo-400 uppercase mb-2">
            <Shapes size={12} /> Word Forms
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ensureArray(data.forms).map((form, idx) => (
              <button
                key={`${form}-${idx}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSearch?.(form);
                }}
                className="inline-flex items-center bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-lg text-sm font-medium hover:bg-indigo-100 transition-colors cursor-pointer border border-indigo-100"
              >
                {form}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Word Family - Related words of different parts of speech */}
      {data.wordFamily && data.wordFamily.length > 0 && (
        <div className="mb-4 shrink-0">
          <div className="flex items-center gap-2 text-xs font-bold text-purple-400 uppercase mb-2">
            <Network size={12} /> Word Family
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.wordFamily.map((entry: WordFamilyEntry, idx: number) => (
              <button
                key={`${entry.word}-${idx}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSearch?.(entry.word);
                }}
                className="inline-flex items-center gap-1.5 bg-purple-50 text-purple-700 px-2.5 py-1 rounded-lg text-sm hover:bg-purple-100 transition-colors cursor-pointer border border-purple-100"
              >
                <span className="font-medium">{entry.word}</span>
                <span className="text-purple-400 text-xs">({entry.pos})</span>
                <span className="text-purple-500 text-xs">{entry.chinese}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4" style={{ WebkitUserSelect: 'text', userSelect: 'text' }}>
        {/* Example Sentences */}
        <div className="bg-slate-50 p-3 rounded-xl select-text">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase mb-2">
            <BookOpen size={12} /> Usage
          </div>
          <ul className="space-y-2">
            {ensureArray(data.examples).map((ex, i) => {
              const word = data.word || '';
              const saveBtn = onSaveSentence && (() => {
                const saved = isSentenceSaved?.(ex) ?? false;
                return (
                  <button
                    onClick={(e) => { e.stopPropagation(); if (!saved) onSaveSentence(ex, data.word, data.sense); }}
                    className={`absolute right-0 top-0 p-0.5 transition-colors ${saved ? 'text-indigo-500' : 'text-indigo-300 hover:text-indigo-600'}`}
                    title={saved ? 'Sentence saved' : 'Save sentence for review'}
                    disabled={saved}
                  >
                    {saved ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}
                  </button>
                );
              })();

              // Two-pass rendering: first split on [[brackets]], then highlight current word in plain segments
              const highlightWord = (text: string, keyPrefix: string) => {
                if (!word || !text) return text;
                try {
                  return text.split(new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')).map((part, j) =>
                    part.toLowerCase() === word.toLowerCase()
                      ? <span key={`${keyPrefix}-w${j}`} className="text-indigo-600 font-bold bg-indigo-50 px-1 rounded">{part}</span>
                      : part
                  );
                } catch { return text; }
              };

              const renderExample = () => {
                // Split on [[...]] brackets for clickable C1/C2 words
                const parts = ex.split(/\[\[(.+?)\]\]/g);
                if (parts.length === 1) {
                  // No brackets found — just highlight the current word
                  return highlightWord(ex, `ex${i}`);
                }
                return parts.map((part, j) =>
                  j % 2 === 1 ? (
                    <button
                      key={`ex${i}-b${j}`}
                      onClick={(e) => { e.stopPropagation(); onSearch?.(part); }}
                      className="text-emerald-600 font-semibold underline decoration-dotted decoration-emerald-300 cursor-pointer hover:bg-emerald-50 rounded px-0.5 transition-colors"
                    >
                      {part}
                    </button>
                  ) : highlightWord(part, `ex${i}-p${j}`)
                );
              };

              return (
                <li key={i} className="text-slate-700 text-sm leading-relaxed border-l-2 border-indigo-200 pl-3 group/sentence relative pr-6">
                  {renderExample()}
                  {saveBtn}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Info Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-orange-50 p-3 rounded-xl">
            <div className="flex items-center gap-2 text-xs font-bold text-orange-400 uppercase mb-1">
              <History size={12} /> Origins
            </div>
            <p className="text-xs text-slate-700">{data.history}</p>
          </div>
          <div className="bg-emerald-50 p-3 rounded-xl">
             <div className="flex items-center gap-2 text-xs font-bold text-emerald-500 uppercase mb-1">
              <Lightbulb size={12} /> Mnemonic
            </div>
            <p className="text-xs text-slate-700">{data.mnemonic}</p>
          </div>
        </div>

        {/* Synonyms/Antonyms/Confusables */}
        <div className="text-sm">
           {/* Synonyms */}
           <div className="mb-1">
             <div className="flex flex-wrap items-baseline gap-2">
               <span className="text-slate-400 font-semibold text-xs uppercase mr-1">Synonyms</span>
               {onCompare && ensureArray(data.synonyms).length > 0 && comparePicking !== 'synonyms' && (
                 <button
                   onClick={(e) => { e.stopPropagation(); startComparePick('synonyms'); }}
                   className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-400 hover:text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-1.5 py-0.5 rounded-full transition-colors uppercase tracking-wider"
                   title="Compare with synonyms"
                 >
                   <Scale size={10} /> Compare
                 </button>
               )}
               {comparePicking === 'synonyms' && (
                 <span className="inline-flex items-center gap-1.5">
                   <button
                     onClick={(e) => { e.stopPropagation(); executeCompare(); }}
                     disabled={compareSelected.size < 1}
                     className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full transition-colors uppercase tracking-wider ${
                       compareSelected.size >= 1
                         ? 'text-white bg-indigo-500 hover:bg-indigo-600'
                         : 'text-slate-400 bg-slate-100 cursor-not-allowed'
                     }`}
                     title="Run comparison"
                   >
                     <Scale size={10} /> Go ({compareSelected.size + 1})
                   </button>
                   <button
                     onClick={(e) => { e.stopPropagation(); cancelComparePick(); }}
                     className="text-slate-400 hover:text-slate-600 p-0.5 rounded-full hover:bg-slate-100 transition-colors"
                     title="Cancel"
                   >
                     <X size={12} />
                   </button>
                 </span>
               )}
               <span className="inline">{renderPills(data.synonyms, comparePicking === 'synonyms')}</span>
             </div>
           </div>

           {/* Antonyms */}
           <p className="mb-1 flex flex-wrap items-baseline gap-2">
             <span className="text-slate-400 font-semibold text-xs uppercase mr-1">Antonyms</span>
             <span className="inline">{renderPills(data.antonyms)}</span>
           </p>

           {/* Confusables */}
           {ensureArray(data.confusables).length > 0 && (
             <div>
               <div className="flex flex-wrap items-baseline gap-2">
                 <span className="text-amber-500 font-semibold text-xs uppercase mr-1">Confusables</span>
                 {onCompare && comparePicking !== 'confusables' && (
                   <button
                     onClick={(e) => { e.stopPropagation(); startComparePick('confusables'); }}
                     className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-400 hover:text-amber-600 bg-amber-50 hover:bg-amber-100 px-1.5 py-0.5 rounded-full transition-colors uppercase tracking-wider"
                     title="Compare with confusables"
                   >
                     <Scale size={10} /> Compare
                   </button>
                 )}
                 {comparePicking === 'confusables' && (
                   <span className="inline-flex items-center gap-1.5">
                     <button
                       onClick={(e) => { e.stopPropagation(); executeCompare(); }}
                       disabled={compareSelected.size < 1}
                       className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full transition-colors uppercase tracking-wider ${
                         compareSelected.size >= 1
                           ? 'text-white bg-amber-500 hover:bg-amber-600'
                           : 'text-slate-400 bg-slate-100 cursor-not-allowed'
                       }`}
                       title="Run comparison"
                     >
                       <Scale size={10} /> Go ({compareSelected.size + 1})
                     </button>
                     <button
                       onClick={(e) => { e.stopPropagation(); cancelComparePick(); }}
                       className="text-slate-400 hover:text-slate-600 p-0.5 rounded-full hover:bg-slate-100 transition-colors"
                       title="Cancel"
                     >
                       <X size={12} />
                     </button>
                   </span>
                 )}
                 <span className="inline">{renderPills(data.confusables, comparePicking === 'confusables')}</span>
               </div>
             </div>
           )}
        </div>
        
         <div className="text-xs text-slate-400 pt-2 border-t border-slate-100 select-text" style={{ WebkitUserSelect: 'text', userSelect: 'text' }}>
            <span className="font-semibold">Register:</span> {data.register}
         </div>
      </div>
    </div>
  );
});
