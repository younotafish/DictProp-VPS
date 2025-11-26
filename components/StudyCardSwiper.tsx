/**
 * StudyCardSwiper Component
 * Handles swipe gestures (Left = Not Memorized, Right = Memorized) for flashcards.
 * Supports both Touch and Mouse interactions.
 */
import React, { useRef, useState, useEffect, useCallback } from 'react';
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
  const startTime = useRef<number>(0);
  const directionLocked = useRef<'horizontal' | 'vertical' | 'selection' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const threshold = 100; // Minimum swipe distance to trigger action
  const dragStartThreshold = 10; // Movement needed before we consider it a drag (lowered for better responsiveness)
  const directionLockThreshold = 5; // Movement needed to determine scroll vs swipe direction
  const textSelectionDelay = 150; // ms - if user holds longer than this before moving, assume text selection intent
  const horizontalRatio = 1.2; // Horizontal movement must be this much greater than vertical to count as swipe

  // Handle Touch Events - using native listeners for iOS Safari compatibility
  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!enabled) return;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    startTime.current = Date.now();
    directionLocked.current = null;
    setIsDragging(true);
  }, [enabled]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!enabled || startX.current === null || startY.current === null) return;
    
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - startX.current;
    const diffY = currentY - startY.current;
    const elapsed = Date.now() - startTime.current;
    
    // Determine direction if not locked yet
    if (!directionLocked.current) {
      const absX = Math.abs(diffX);
      const absY = Math.abs(diffY);
      
      // Need some movement before we can determine direction
      if (absX > directionLockThreshold || absY > directionLockThreshold) {
        // Require strongly horizontal movement to trigger swipe
        // This makes swiping more intentional - diagonal or mostly vertical = scroll/select
        if (absX > absY * horizontalRatio) {
          // If user held for a while before moving horizontally, assume text selection intent
          if (elapsed > textSelectionDelay) {
            directionLocked.current = 'selection';
            return; // Let the browser handle text selection
          }
          directionLocked.current = 'horizontal';
          // Prevent default immediately to lock the gesture
          if (e.cancelable) e.preventDefault();
        } else {
          // Anything else (vertical, diagonal) = let browser handle it
          directionLocked.current = 'vertical';
          return;
        }
      }
    }
    
    // If locked to vertical or selection, don't handle horizontal swipe
    if (directionLocked.current === 'vertical' || directionLocked.current === 'selection') {
      return;
    }
    
    // Only start visual dragging after threshold is met and direction is horizontal
    if (directionLocked.current === 'horizontal') {
      // CRITICAL for iOS Safari: prevent default to stop browser's own gesture handling
      if (e.cancelable) e.preventDefault();

      if (Math.abs(diffX) > dragStartThreshold) {
        setIsActuallyDragging(true);
        setOffset(diffX);
      }
    }
  }, [enabled]);

  const handleTouchEnd = useCallback(() => {
    handleEnd();
  }, []);

  // Attach native touch listeners with { passive: false } for iOS Safari
  // This allows preventDefault() to work during horizontal swipes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false }); // passive: false is CRITICAL
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  // Handle Mouse Events
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!enabled) return;
    startX.current = e.clientX;
    startY.current = e.clientY;
    startTime.current = Date.now();
    directionLocked.current = null;
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!enabled || startX.current === null || startY.current === null || !isDragging) return;
    
    const currentX = e.clientX;
    const currentY = e.clientY;
    const diffX = currentX - startX.current;
    const diffY = currentY - startY.current;
    const elapsed = Date.now() - startTime.current;
    
    // Determine direction if not locked yet
    if (!directionLocked.current) {
      const absX = Math.abs(diffX);
      const absY = Math.abs(diffY);
      
      if (absX > directionLockThreshold || absY > directionLockThreshold) {
        // Require strongly horizontal movement to trigger swipe
        if (absX > absY * horizontalRatio) {
          // If user held for a while before moving horizontally, assume text selection intent
          if (elapsed > textSelectionDelay) {
            directionLocked.current = 'selection';
            return;
          }
          directionLocked.current = 'horizontal';
        } else {
          // Anything else (vertical, diagonal) = let browser handle it
          directionLocked.current = 'vertical';
          return;
        }
      }
    }
    
    if (directionLocked.current === 'vertical' || directionLocked.current === 'selection') {
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
      className={`relative w-full h-full ${isActuallyDragging ? 'select-none' : 'select-text'}`}
      style={{ 
        // iOS Safari: touch-action must be 'none' when dragging to prevent browser interference
        // Otherwise allow pan-y for vertical scrolling
        touchAction: isActuallyDragging ? 'none' : 'pan-y',
        WebkitUserSelect: isActuallyDragging ? 'none' : 'text', 
        userSelect: isActuallyDragging ? 'none' : 'text',
        WebkitTouchCallout: isActuallyDragging ? 'none' : 'default'
      }}
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
