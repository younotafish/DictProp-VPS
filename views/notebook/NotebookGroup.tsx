import React, { useState, useRef, useCallback } from 'react';
import type { ItemGroup, StoredItem } from '../../types';
import type { NotebookSection } from '../../services/notebookList';
import { useWheelNavigation } from '../../hooks';
import { NotebookItem } from './NotebookItem';
import { CarouselArrow, CarouselDots } from './Carousel';
import { useHorizontalSwipe } from './useHorizontalSwipe';

// Carousel wrapper for grouped items with same spelling
interface NotebookGroupProps {
  group: ItemGroup;
  section: NotebookSection;
  /** The list's clock, which the Due badges count from. */
  now: number;
  onViewDetail: (group: ItemGroup, section: NotebookSection, itemIndex: number) => void;
  onDelete: (id: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
}

const isDueAt = (item: StoredItem, now: number) => (item.srs?.nextReview ?? 0) <= now;

// A row redraws when its group (a new one only when its senses changed, see buildNotebookList), its section or a
// handler changes, or when the list's clock passes the review time of one of its senses, flipping its Due badge.
// A clock that moves on without flipping one changes nothing the row shows.
const sameRow = (a: NotebookGroupProps, b: NotebookGroupProps): boolean =>
  a.group === b.group && a.section === b.section && a.onViewDetail === b.onViewDetail && a.onDelete === b.onDelete &&
  a.onArchive === b.onArchive && a.onUnarchive === b.onUnarchive &&
  (a.now === b.now || a.group.items.every(item => isDueAt(item, a.now) === isDueAt(item, b.now)));

export const NotebookGroup: React.FC<NotebookGroupProps> = React.memo(({
  group, section, now, onViewDetail, onDelete, onArchive, onUnarchive
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const totalItems = group.items.length;
  const carouselRef = useRef<HTMLDivElement>(null);
  const openSense = useCallback(
    (itemIndex: number) => onViewDetail(group, section, itemIndex),
    [onViewDetail, group, section],
  );

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
        isDue={isDueAt(group.items[0], now)}
        itemIndex={0}
        onOpen={openSense}
        onDelete={onDelete}
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
          isDue={isDueAt(currentItem, now)}
          itemIndex={index}
          onOpen={openSense}
          onDelete={onDelete}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
          totalInGroup={totalItems}
        />
      </div>
      
      {/* Dot indicators */}
      <CarouselDots count={totalItems} index={index} onSelect={setCurrentIndex} />
    </div>
  );
}, sameRow);
