
import React from 'react';
import { VocabCard as VocabType } from '../types';
import { Sparkles, BookOpen, History, Lightbulb, Maximize2, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { PronunciationBlock } from './PronunciationBlock';

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
}

export const VocabCardDisplay: React.FC<Props> = ({ 
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
  showRefresh = true
}) => {
  
  // Robust helper to ensure we always map over an array
  const ensureArray = (items: any): string[] => {
    if (Array.isArray(items)) return items;
    if (typeof items === 'string') return [items];
    return [];
  };

  const renderPills = (items: any) => ensureArray(items).map((item, idx) => (
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
  ));

  return (
    <div className={`bg-white rounded-2xl p-5 shadow-md border border-slate-100 flex flex-col h-full ${scrollable ? 'overflow-y-auto no-scrollbar' : 'overflow-hidden'} ${className}`}>
      {/* Header */}
      <div className="flex justify-between items-start mb-3 shrink-0">
        <div>
          <h3 className="text-2xl font-bold text-slate-800 tracking-tight">{data.word || ''}</h3>
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
        <div className="mb-4 rounded-xl overflow-hidden h-32 w-full bg-slate-50 border border-slate-100 shadow-inner shrink-0">
          <img src={data.imageUrl} alt={data.word} className="w-full h-full object-cover fade-in" />
        </div>
      )}

      {/* Core Meaning */}
      <div className="mb-4 shrink-0">
        <p className="text-xl text-slate-700 font-medium">{data.chinese}</p>
        <p className="text-slate-500 mt-1 italic">{data.definition}</p>
      </div>

      <div className="space-y-4">
        {/* Example Sentences */}
        <div className="bg-slate-50 p-3 rounded-xl">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase mb-2">
            <BookOpen size={12} /> Usage
          </div>
          <ul className="space-y-2">
            {ensureArray(data.examples).map((ex, i) => (
              <li key={i} className="text-slate-700 text-sm leading-relaxed border-l-2 border-indigo-200 pl-3">
                 {ex.split(new RegExp(`(${data.word})`, 'gi')).map((part, j) => 
                    part.toLowerCase() === (data.word || '').toLowerCase() 
                    ? <span key={j} className="text-indigo-600 font-bold bg-indigo-50 px-1 rounded">{part}</span> 
                    : part
                 )}
              </li>
            ))}
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

        {/* Synonyms/Antonyms */}
        <div className="text-sm">
           <p className="mb-1 flex flex-wrap items-baseline gap-2">
             <span className="text-slate-400 font-semibold text-xs uppercase mr-1">Synonyms</span> 
             <span className="inline">{renderPills(data.synonyms)}</span>
           </p>
           <p className="flex flex-wrap items-baseline gap-2">
             <span className="text-slate-400 font-semibold text-xs uppercase mr-1">Antonyms</span>
             <span className="inline">{renderPills(data.antonyms)}</span>
           </p>
        </div>
        
         <div className="text-xs text-slate-400 pt-2 border-t border-slate-100">
            Register: {data.register}
         </div>
      </div>
    </div>
  );
};
