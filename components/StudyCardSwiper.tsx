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
  const startX = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const threshold = 100; // Minimum swipe distance to trigger action

  // Handle Touch Events
  const handleTouchStart = (e: React.TouchEvent) => {
    if (!enabled) return;
    startX.current = e.touches[0].clientX;
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!enabled || startX.current === null) return;
    const currentX = e.touches[0].clientX;
    const diff = currentX - startX.current;
    setOffset(diff);
  };

  const handleTouchEnd = () => {
    handleEnd();
  };

  // Handle Mouse Events
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!enabled) return;
    startX.current = e.clientX;
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!enabled || startX.current === null || !isDragging) return;
    const currentX = e.clientX;
    const diff = currentX - startX.current;
    setOffset(diff);
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
  };

  const getOverlayOpacity = () => {
    const absOffset = Math.abs(offset);
    return Math.min(absOffset / (threshold * 1.5), 0.8);
  };

  return (
    <div 
      ref={containerRef}
      className="relative w-full h-full touch-pan-y select-none"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      <div 
        className="w-full h-full transition-transform duration-300 ease-out will-change-transform cursor-grab active:cursor-grabbing"
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
