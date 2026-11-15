import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { VocabCard } from '../../types';
import { VocabCardDisplay } from '../VocabCard';
import { EyesFreeZones, type ZoneFlash } from '../EyesFreeZones';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';

interface Props {
  /** The open result's meanings, and the one on screen. */
  vocabs: VocabCard[];
  viewingVocab: VocabCard;
  viewingVocabIdx: number;
  viewingVocabCount: number;
  setViewingVocabIdx: React.Dispatch<React.SetStateAction<number>>;
  onCardZoneRead: (e: React.MouseEvent<HTMLElement>) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  zoneFlash: ZoneFlash | null;
  isVocabSaved: (vocab: VocabCard) => boolean;
  onSaveVocab: (vocab: VocabCard) => void;
  onSearch: (text: string) => void;
  onRefresh: (word: string) => void;
  onCompare?: (words: string[]) => void;
  onLazyLoadImage?: (itemId: string, imageVersion?: string) => Promise<string | null>;
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
}

/**
 * The open meaning in the results sheet: its card, the arrows and dots that switch meanings, and the
 * eyes-free zones over the visible card area.
 */
export const SearchVocabPane: React.FC<Props> = ({
  vocabs, viewingVocab, viewingVocabIdx, viewingVocabCount, setViewingVocabIdx, onCardZoneRead, onTouchStart, onTouchEnd,
  zoneFlash, isVocabSaved, onSaveVocab, onSearch, onRefresh, onCompare, onLazyLoadImage, onSaveSentence, isSentenceSaved,
}) => (
  <>
  <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4" onClick={onCardZoneRead}>
    <div className="relative max-w-screen-md mx-auto">
      {/* Navigation arrows for vocabs */}
      {viewingVocabCount > 1 && viewingVocabIdx > 0 && (
        <button
          onClick={() => { setViewingVocabIdx(viewingVocabIdx - 1); }}
          aria-label="Previous meaning"
          className="absolute -left-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
        >
          <ChevronLeft size={16} />
        </button>
      )}
      {viewingVocabCount > 1 && (
        <button
          onClick={() => { setViewingVocabIdx((viewingVocabIdx + 1) % viewingVocabCount); }}
          aria-label="Next meaning"
          className="absolute -right-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
        >
          <ChevronRight size={16} />
        </button>
      )}

      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <VocabCardDisplay
          data={viewingVocab}
          isSaved={isVocabSaved(viewingVocab)}
          onSave={() => onSaveVocab(viewingVocab)}
          showSave={true}
          onSearch={onSearch}
          onRefresh={onRefresh}
          onCompare={onCompare}
          scrollable={false}
          onLazyLoadImage={onLazyLoadImage}
          onSaveSentence={onSaveSentence}
          isSentenceSaved={isSentenceSaved}
          className="!h-auto !overflow-visible border-indigo-200 shadow-sm bg-white"
        />
      </div>

      {/* Vocab dot indicators */}
      {viewingVocabCount > 1 && (
        <div className="flex justify-center gap-1.5 mt-3">
          {vocabs.map((_, idx) => (
            <button
              key={idx}
              onClick={() => setViewingVocabIdx(idx)}
              aria-label={`Meaning ${idx + 1}`}
              aria-current={idx === viewingVocabIdx ? 'true' : undefined}
              className={`w-2 h-2 rounded-full transition-all ${
                idx === viewingVocabIdx
                  ? 'bg-indigo-500 w-4'
                  : 'bg-slate-300 hover:bg-slate-400'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  </div>
  <EyesFreeZones
    anchor="fill"
    bands={Math.min(2, (viewingVocab?.examples || []).map(s => stripSentenceMarkers(s || '').trim()).filter(Boolean).length)}
    flash={zoneFlash}
  />
  </>
);
