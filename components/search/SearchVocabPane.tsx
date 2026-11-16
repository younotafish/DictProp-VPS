import React, { useCallback, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { VocabCard } from '../../types';
import { VocabCardDisplay } from '../VocabCard';
import { EyesFreeZones, eyesFreeZoneAt, type ZoneFlash } from '../EyesFreeZones';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { stepMeaning } from './searchViewing';

const SWIPE_THRESHOLD = 50;

interface Props {
  /** The open result's meanings, and the one on screen. */
  vocabs: VocabCard[];
  meaningIndex: number;
  /** Shows another meaning; with `speak`, also says its word. */
  onShowMeaning: (index: number, options?: { speak?: boolean }) => void;
  zoneFlash: ZoneFlash | null;
  flashZone: (zone: number) => void;
  playOrToggleSentence: (sentence: string) => void;
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
 * The open meaning in the results sheet: its card, the arrows, swipes and dots that switch meanings, and the
 * eyes-free zones over the visible card area.
 */
export const SearchVocabPane: React.FC<Props> = ({
  vocabs, meaningIndex, onShowMeaning, zoneFlash, flashZone, playOrToggleSentence,
  isVocabSaved, onSaveVocab, onSearch, onRefresh, onCompare, onLazyLoadImage, onSaveSentence, isSentenceSaved,
}) => {
  const viewingVocab = vocabs[meaningIndex];
  const viewingVocabCount = vocabs.length;
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // The card's example sentences as they're read aloud: the zone guides and the zone taps both use them.
  const plainExamples = useMemo(
    () => (viewingVocab?.examples || []).map(s => stripSentenceMarkers(s || '').trim()).filter(Boolean),
    [viewingVocab],
  );
  // A stable save handler, so the memoized card doesn't re-render for queue changes it doesn't show.
  const saveViewing = useCallback(() => onSaveVocab(viewingVocab), [onSaveVocab, viewingVocab]);

  // Moves to the next or previous meaning. Each control keeps its own rule: the arrows wrap only forwards and
  // stay quiet; a swipe says the word, and wraps only forwards too.
  const step = (delta: 1 | -1, wrap: boolean, speak: boolean) => {
    const next = stepMeaning(meaningIndex, viewingVocabCount, delta, wrap);
    if (next !== null) onShowMeaning(next, { speak });
  };

  // Touch handlers for swipe navigation in results popup
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const diffX = e.changedTouches[0].clientX - touchStart.current.x;
    const diffY = e.changedTouches[0].clientY - touchStart.current.y;
    touchStart.current = null;

    if (Math.abs(diffX) <= Math.abs(diffY) * 1.5 || Math.abs(diffX) <= SWIPE_THRESHOLD) return;

    // A swipe left goes to the next meaning, round to the first after the last; a swipe right goes back, and
    // stops at the first.
    step(diffX < 0 ? 1 : -1, diffX < 0, true);
  };

  // Eyes-free zone read: a click/tap in the popup body's top quarter plays the 1st example sentence, the
  // second quarter the 2nd; the bottom half is inert. Zones are measured against the VISIBLE popup body
  // (the scroll container is e.currentTarget), NOT the full card — so they stay the same on-screen bands no
  // matter how far a tall card is scrolled, and you never have to chase the tiny speaker icon. Mirrors the
  // DetailView eyes-free zones and routes through the shared playback so a second tap on the same zone
  // pauses/resumes. One onClick path covers desktop clicks AND mobile taps (synthesized click); controls
  // inside the card stopPropagation, and the guard skips the rest.
  const handleCardZoneRead = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (window.getSelection()?.toString().trim()) return; // don't hijack a text selection
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, [role="button"], input, textarea, select, label')) return; // a control
    if (!plainExamples.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const zone = eyesFreeZoneAt(e.clientY - rect.top, rect.height); // top ¼ → 1st, 2nd ¼ → 2nd
    if (zone < 0) return;
    flashZone(zone);
    playOrToggleSentence(plainExamples[Math.min(zone, plainExamples.length - 1)]);
  }, [plainExamples, flashZone, playOrToggleSentence]);

  return (
    <>
    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4" onClick={handleCardZoneRead}>
      <div className="relative max-w-screen-md mx-auto">
        {/* Navigation arrows for vocabs */}
        {viewingVocabCount > 1 && meaningIndex > 0 && (
          <button
            onClick={() => step(-1, false, false)}
            aria-label="Previous meaning"
            className="absolute -left-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        {viewingVocabCount > 1 && (
          <button
            onClick={() => step(1, true, false)}
            aria-label="Next meaning"
            className="absolute -right-1 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-md hover:bg-indigo-50 transition-colors hidden md:flex"
          >
            <ChevronRight size={16} />
          </button>
        )}

        <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          <VocabCardDisplay
            data={viewingVocab}
            isSaved={isVocabSaved(viewingVocab)}
            onSave={saveViewing}
            showSave={true}
            onSearch={onSearch}
            onRefresh={onRefresh}
            onCompare={onCompare}
            onLazyLoadImage={onLazyLoadImage}
            onSaveSentence={onSaveSentence}
            isSentenceSaved={isSentenceSaved}
            className="shadow-sm"
          />
        </div>

        {/* Vocab dot indicators */}
        {viewingVocabCount > 1 && (
          <div className="flex justify-center gap-1.5 mt-3">
            {vocabs.map((_, idx) => (
              <button
                key={idx}
                onClick={() => onShowMeaning(idx)}
                aria-label={`Meaning ${idx + 1}`}
                aria-current={idx === meaningIndex ? 'true' : undefined}
                className={`w-2 h-2 rounded-full transition-all ${
                  idx === meaningIndex
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
      bands={Math.min(2, plainExamples.length)}
      flash={zoneFlash}
    />
    </>
  );
};
