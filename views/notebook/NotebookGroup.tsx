import React, { useState, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ItemGroup } from '../../types';
import type { NotebookSection } from '../../services/notebookList';
import { useWheelNavigation } from '../../hooks';
import { NotebookItem } from './NotebookItem';

// Carousel wrapper for grouped items with same spelling
interface NotebookGroupProps {
  group: ItemGroup;
  section: NotebookSection;
  groupIndex: number;
  onViewDetail: (section: NotebookSection, groupIndex: number, itemIndex: number) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
}

export const NotebookGroup: React.FC<NotebookGroupProps> = React.memo(({
  group, section, groupIndex, onViewDetail, onDelete, onArchive, onUnarchive
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const totalItems = group.items.length;
  const carouselRef = useRef<HTMLDivElement>(null);

  const touchStart = useRef<{x: number, y: number} | null>(null);
  const SWIPE_THRESHOLD = 50;
  
  // Trackpad wheel navigation for carousel
  useWheelNavigation({
    onScrollLeft: () => setCurrentIndex((prev) => (prev - 1 + totalItems) % totalItems),
    onScrollRight: () => setCurrentIndex((prev) => (prev + 1) % totalItems),
    containerRef: carouselRef,
    threshold: 80,
    enabled: totalItems > 1,
  });
  
  // Single item - no carousel needed
  if (totalItems === 1) {
    return (
      <NotebookItem
        item={group.items[0]}
        onDelete={onDelete}
        onViewDetail={() => onViewDetail(section, groupIndex, 0)}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
      />
    );
  }
  
  // Multiple items - carousel mode. Deleting a sense can leave the index past the end.
  const index = Math.min(currentIndex, totalItems - 1);
  const currentItem = group.items[index];
  
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    
    // Check if user is selecting text - don't interfere with text selection on iOS
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      touchStart.current = null;
      return;
    }
    
    const diffX = e.changedTouches[0].clientX - touchStart.current.x;
    const diffY = e.changedTouches[0].clientY - touchStart.current.y;
    const absX = Math.abs(diffX);
    const absY = Math.abs(diffY);
    if (absX > absY * 1.5 && absX > SWIPE_THRESHOLD) {
      if (diffX < 0) {
        setCurrentIndex((prev) => (prev + 1) % totalItems);
      } else {
        setCurrentIndex((prev) => (prev - 1 + totalItems) % totalItems);
      }
    }
    touchStart.current = null;
  };
  
  return (
    <div ref={carouselRef} className="relative" style={{ touchAction: 'pan-y' }}>
      {/* Navigation arrows for desktop */}
      {index > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); setCurrentIndex(index - 1); }}
          className="absolute -left-2 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-violet-600 rounded-full flex items-center justify-center shadow-md hover:bg-violet-50 transition-colors hidden md:flex"
          aria-label="Previous meaning"
        >
          <ChevronLeft size={16} />
        </button>
      )}
      {index < totalItems - 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); setCurrentIndex(index + 1); }}
          className="absolute -right-2 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white text-violet-600 rounded-full flex items-center justify-center shadow-md hover:bg-violet-50 transition-colors hidden md:flex"
          aria-label="Next meaning"
        >
          <ChevronRight size={16} />
        </button>
      )}
      {/* Card */}
      <div className="w-full" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        <NotebookItem
          item={currentItem}
          onDelete={onDelete}
          onViewDetail={() => onViewDetail(section, groupIndex, index)}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
          totalInGroup={totalItems}
        />
      </div>
      
      {/* Dot indicators — each button is taller and wider than the dot it draws, so it's easier to hit */}
      <div className="flex justify-center">
        {group.items.map((_, idx) => (
          <button
            key={idx}
            onClick={(e) => { e.stopPropagation(); setCurrentIndex(idx); }}
            className="group/dot h-6 px-[3px] flex items-center"
            aria-label={`Meaning ${idx + 1} of ${totalItems}`}
            aria-current={idx === index ? 'true' : undefined}
          >
            <span className={`block w-2 h-2 rounded-full transition-all ${
              idx === index
                ? 'bg-violet-500 w-4' 
                : 'bg-slate-300 group-hover/dot:bg-slate-400'
            }`} />
          </button>
        ))}
      </div>
    </div>
  );
});
