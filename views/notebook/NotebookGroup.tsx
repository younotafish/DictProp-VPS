import React, { useState, useRef } from 'react';
import type { ItemGroup } from '../../types';
import type { NotebookSection } from '../../services/notebookList';
import { useWheelNavigation } from '../../hooks';
import { NotebookItem } from './NotebookItem';
import { CarouselArrow, CarouselDots } from './Carousel';
import { useHorizontalSwipe } from './useHorizontalSwipe';

// Carousel wrapper for grouped items with same spelling
interface NotebookGroupProps {
  group: ItemGroup;
  section: NotebookSection;
  groupIndex: number;
  /** The list's clock, which the Due badges count from. */
  now: number;
  onViewDetail: (section: NotebookSection, groupIndex: number, itemIndex: number) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
}

export const NotebookGroup: React.FC<NotebookGroupProps> = React.memo(({
  group, section, groupIndex, now, onViewDetail, onDelete, onArchive, onUnarchive
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const totalItems = group.items.length;
  const carouselRef = useRef<HTMLDivElement>(null);

  // Left swipe -> next meaning, right swipe -> previous, both looping
  const swipe = useHorizontalSwipe({
    onSwipeLeft: () => setCurrentIndex((prev) => (prev + 1) % totalItems),
    onSwipeRight: () => setCurrentIndex((prev) => (prev - 1 + totalItems) % totalItems),
  });

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
        now={now}
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

  return (
    <div ref={carouselRef} className="relative" style={{ touchAction: 'pan-y' }}>
      {/* Navigation arrows for desktop */}
      {index > 0 && <CarouselArrow direction="previous" onClick={() => setCurrentIndex(index - 1)} />}
      {index < totalItems - 1 && <CarouselArrow direction="next" onClick={() => setCurrentIndex(index + 1)} />}
      {/* Card */}
      <div className="w-full" onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd}>
        <NotebookItem
          item={currentItem}
          now={now}
          onDelete={onDelete}
          onViewDetail={() => onViewDetail(section, groupIndex, index)}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
          totalInGroup={totalItems}
        />
      </div>
      
      {/* Dot indicators */}
      <CarouselDots count={totalItems} index={index} onSelect={setCurrentIndex} />
    </div>
  );
});
