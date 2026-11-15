import React, { useState, useRef, useCallback } from 'react';
import { Wand2 } from 'lucide-react';
import type { VocabCard } from '../../types';
import { VocabCardDisplay } from '../../components/VocabCard';
import { useWheelNavigation } from '../../hooks';
import { speakWord } from '../../services/lazyTts';
import { isDialogOpenOutside, isTypingTarget } from '../../components/keyboardTarget';
import { CarouselArrow, CarouselDots } from './Carousel';
import { useHorizontalSwipe } from './useHorizontalSwipe';

// Search results carousel component
interface SearchResultsCarouselProps {
  vocabs: VocabCard[];
  onSave: (vocab: VocabCard) => void;
  isVocabSaved: (vocab: VocabCard) => boolean;
  onSearch: (text: string) => void;
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
  /** False while a card or dialog is open over the notebook, whose arrow keys are its own. */
  keyboardEnabled: boolean;
}

export const SearchResultsCarousel: React.FC<SearchResultsCarouselProps> = ({
  vocabs, onSave, isVocabSaved, onSearch, onSaveSentence, isSentenceSaved, keyboardEnabled
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const carouselRef = useRef<HTMLDivElement>(null);
  const totalItems = vocabs.length;

  // Navigate and pronounce - called by user interactions
  const navigateTo = useCallback((newIndex: number) => {
    setCurrentIndex(newIndex);
    const vocab = vocabs[newIndex];
    if (vocab?.word) {
      speakWord(vocab.word);
    }
  }, [vocabs]);
  
  // Trackpad wheel navigation
  // Left scroll (wheel right) loops, right scroll (wheel left) stops at first
  useWheelNavigation({
    onScrollLeft: () => { if (currentIndex > 0) navigateTo(currentIndex - 1); },
    onScrollRight: () => navigateTo((currentIndex + 1) % totalItems),
    containerRef: carouselRef,
    threshold: 80,
    enabled: totalItems > 1,
  });

  // Keyboard arrow navigation
  React.useEffect(() => {
    if (totalItems <= 1 || !keyboardEnabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      // A dialog the notebook opened itself (text analyzer, imports) or the search sheet has the keys.
      if (isDialogOpenOutside(null)) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (currentIndex > 0) navigateTo(currentIndex - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateTo((currentIndex + 1) % totalItems);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [totalItems, currentIndex, navigateTo, keyboardEnabled]);

  const swipe = useHorizontalSwipe({
    // Left swipe -> next item, loops forever
    onSwipeLeft: () => navigateTo((currentIndex + 1) % totalItems),
    // Right swipe -> previous item, stops at first
    onSwipeRight: () => {
      if (currentIndex > 0) {
        navigateTo(currentIndex - 1);
      }
    },
  });

  const currentVocab = vocabs[currentIndex];
  
  return (
    <div className="px-3 pt-3 pb-2">
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Wand2 size={14} className="text-violet-500" />
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Search Results</span>
        </div>
        {totalItems > 1 && (
          <span className="text-xs font-bold text-violet-600 bg-violet-50 px-2.5 py-1 rounded-full border border-violet-100">
            {currentIndex + 1}/{totalItems}
          </span>
        )}
      </div>
      
      <div ref={carouselRef} className="relative max-w-screen-md lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl mx-auto" style={{ touchAction: 'pan-y' }}>
        {/* Navigation arrows for desktop */}
        {/* Previous arrow - only shows when not at first item */}
        {totalItems > 1 && currentIndex > 0 && <CarouselArrow direction="previous" onClick={() => navigateTo(currentIndex - 1)} />}
        {/* Next arrow - always shows (loops forever) */}
        {totalItems > 1 && <CarouselArrow direction="next" onClick={() => navigateTo((currentIndex + 1) % totalItems)} />}

        <div onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd}>
          <VocabCardDisplay
            data={currentVocab}
            isSaved={isVocabSaved(currentVocab)}
            onSave={() => onSave(currentVocab)}
            showSave={true}
            onSearch={onSearch}
            scrollable={false}
            className="!h-auto !overflow-visible border-violet-200 shadow-sm hover:shadow-md transition-shadow bg-white"
            onSaveSentence={onSaveSentence}
            isSentenceSaved={isSentenceSaved}
          />
        </div>
        
        {/* Dot indicators */}
        {totalItems > 1 && (
          <CarouselDots count={totalItems} index={currentIndex} onSelect={navigateTo} className="flex justify-center mt-1" />
        )}
      </div>
      
      <div className="border-b border-slate-200 mt-4 mb-2" />
    </div>
  );
};
