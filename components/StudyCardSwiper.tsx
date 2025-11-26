/**
 * StudyCardSwiper Component
 * Handles swipe gestures (Left = Not Memorized, Right = Memorized) for flashcards.
 * Supports both Touch and Mouse interactions.
 */
import React, { useRef, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';

interface SwiperProps {
  children: React.ReactNode;
  onSwipe: (direction: 'left' | 'right') => void;
  enabled: boolean;
}

export const StudyCardSwiper: React.FC<SwiperProps> = ({ children, onSwipe, enabled }) => {
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isActuallyDragging, setIsActuallyDragging] = useState(false); // True only after drag threshold is met
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const threshold = 100; // Minimum swipe distance to trigger action
  const dragStartThreshold = 15; // Movement needed before we consider it a drag (allows text selection)
  const directionLockThreshold = 10; // Movement needed to determine scroll vs swipe direction

  // Check if touch target is likely for text selection
  const isTextSelectionTarget = (target: EventTarget | null): boolean => {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    // Allow selection on text-heavy elements
    if (['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'label', 'div'].includes(tagName)) {
      // Check if this element or a parent has select-text class
      let el: HTMLElement | null = target;
      while (el) {
        if (el.classList.contains('select-text')) {
          return true;
        }
        el = el.parentElement;
      }
    }
    // Check computed style
    const style = window.getComputedStyle(target);
    const userSelect = style.getPropertyValue('user-select') || style.getPropertyValue('-webkit-user-select');
    if (userSelect === 'text') {
      return true;
    }
    return false;
  };

  // Handle Touch Events
  const handleTouchStart = (e: React.TouchEvent) => {
    if (!enabled) return;
    // Don't capture touch if user might be trying to select text
    if (isTextSelectionTarget(e.target)) {
      return;
    }
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    directionLocked.current = null;
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!enabled || startX.current === null || startY.current === null) return;
    
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - startX.current;
    const diffY = currentY - startY.current;
    
    // Determine direction if not locked yet
    if (!directionLocked.current) {
      const absX = Math.abs(diffX);
      const absY = Math.abs(diffY);
      
      // Need some movement before we can determine direction
      if (absX > directionLockThreshold || absY > directionLockThreshold) {
        // If vertical movement is greater, lock to vertical (scrolling)
        // Use a 1.2 ratio to favor vertical scrolling slightly
        if (absY > absX * 1.2) {
          directionLocked.current = 'vertical';
          return; // Let the browser handle scroll
        } else if (absX > absY) {
          directionLocked.current = 'horizontal';
        }
      }
    }
    
    // If locked to vertical, don't handle horizontal swipe
    if (directionLocked.current === 'vertical') {
      return;
    }
    
    // Only start visual dragging after threshold is met and direction is horizontal
    if (directionLocked.current === 'horizontal' && Math.abs(diffX) > dragStartThreshold) {
      setIsActuallyDragging(true);
      setOffset(diffX);
    }
  };

  const handleTouchEnd = () => {
    handleEnd();
  };

  // Handle Mouse Events
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!enabled) return;
    // Don't capture mouse if user might be trying to select text
    if (isTextSelectionTarget(e.target)) {
      return;
    }
    startX.current = e.clientX;
    startY.current = e.clientY;
    directionLocked.current = null;
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!enabled || startX.current === null || startY.current === null || !isDragging) return;
    
    const currentX = e.clientX;
    const currentY = e.clientY;
    const diffX = currentX - startX.current;
    const diffY = currentY - startY.current;
    
    // Determine direction if not locked yet
    if (!directionLocked.current) {
      const absX = Math.abs(diffX);
      const absY = Math.abs(diffY);
      
      if (absX > directionLockThreshold || absY > directionLockThreshold) {
        if (absY > absX * 1.2) {
          directionLocked.current = 'vertical';
          return;
        } else if (absX > absY) {
          directionLocked.current = 'horizontal';
        }
      }
    }
    
    if (directionLocked.current === 'vertical') {
      return;
    }
    
    // Only start visual dragging after threshold is met
    if (directionLocked.current === 'horizontal' && Math.abs(diffX) > dragStartThreshold) {
      setIsActuallyDragging(true);
      setOffset(diffX);
    }
  };

  const handleMouseUp = () => {
    handleEnd();
  };

  const handleMouseLeave = () => {
    if (isDragging) {
      handleEnd();
    }
  };

  // Common End Handler
  const handleEnd = () => {
    if (!enabled || startX.current === null) return;
    
    setIsDragging(false);
    setIsActuallyDragging(false);
    directionLocked.current = null;
    
    if (Math.abs(offset) > threshold) {
      // Trigger swipe action
      const direction = offset > 0 ? 'right' : 'left';
      
      // Animate off screen
      const finalOffset = offset > 0 ? 500 : -500;
      setOffset(finalOffset);
      
      // Wait for animation then trigger callback
      setTimeout(() => {
        onSwipe(direction);
        // Reset state (parent should have replaced the card content by now)
        setOffset(0);
      }, 300);
    } else {
      // Reset position if threshold not met
      setOffset(0);
    }
    startX.current = null;
    startY.current = null;
  };

  const getOverlayOpacity = () => {
    const absOffset = Math.abs(offset);
    return Math.min(absOffset / (threshold * 1.5), 0.8);
  };

  return (
    <div 
      ref={containerRef}
      className={`relative w-full h-full touch-pan-y ${isActuallyDragging ? 'select-none' : 'select-text'}`}
      style={{ 
        WebkitUserSelect: isActuallyDragging ? 'none' : 'text', 
        userSelect: isActuallyDragging ? 'none' : 'text',
        WebkitTouchCallout: isActuallyDragging ? 'none' : 'default'
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      <div 
        className={`w-full h-full transition-transform duration-300 ease-out will-change-transform ${isActuallyDragging ? 'cursor-grabbing' : 'cursor-auto'}`}
        style={{ 
          transform: `translateX(${offset}px) rotate(${offset * 0.05}deg)`,
          transition: isDragging ? 'none' : 'transform 0.3s ease-out'
        }}
      >
        {children}
        
        {/* Right Swipe Overlay (Memorized - Green) */}
        {offset > 0 && (
           <div 
             className="absolute inset-0 bg-emerald-500 rounded-[2rem] flex items-center justify-center z-20 pointer-events-none border-4 border-emerald-400"
             style={{ opacity: getOverlayOpacity() }}
           >
             <div className="bg-white/20 backdrop-blur-sm p-6 rounded-full transform scale-150">
                <ThumbsUp size={48} className="text-white" strokeWidth={3} />
             </div>
           </div>
        )}

        {/* Left Swipe Overlay (Not Memorized - Red) */}
        {offset < 0 && (
           <div 
             className="absolute inset-0 bg-rose-500 rounded-[2rem] flex items-center justify-center z-20 pointer-events-none border-4 border-rose-400"
             style={{ opacity: getOverlayOpacity() }}
           >
             <div className="bg-white/20 backdrop-blur-sm p-6 rounded-full transform scale-150">
                <ThumbsDown size={48} className="text-white" strokeWidth={3} />
             </div>
           </div>
        )}
      </div>
    </div>
  );
};
