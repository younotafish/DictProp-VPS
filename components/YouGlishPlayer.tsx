import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Loader2 } from 'lucide-react';

declare global {
  interface Window {
    YG: any;
    onYouglishAPIReady: () => void;
  }
}

interface Props {
  word: string;
  onClose: () => void;
}

export const YouGlishPlayer: React.FC<Props> = ({ word, onClose }) => {
  const widgetRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [noResults, setNoResults] = useState(false);

  // Escape key closes modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Load widget
  useEffect(() => {
    let mounted = true;

    const createWidget = () => {
      if (!mounted || !window.YG) return;
      setLoading(false);
      widgetRef.current = new window.YG.Widget('youglish-widget', {
        width: Math.min(600, window.innerWidth - 48),
        components: 8 + 16 + 64, // caption + speed + controls
        events: {
          'onFetchDone': (e: any) => {
            if (!mounted) return;
            if (e.totalResult === 0) setNoResults(true);
          },
          'onCaptionConsumed': () => {
            widgetRef.current?.next();
          }
        }
      });
      widgetRef.current.fetch(word, 'english', 'us');
    };

    if (window.YG) {
      createWidget();
    } else {
      window.onYouglishAPIReady = createWidget;
      const script = document.createElement('script');
      script.src = 'https://youglish.com/public/emb/widget.js';
      script.charset = 'utf-8';
      document.head.appendChild(script);
    }

    return () => {
      mounted = false;
      if (widgetRef.current) {
        widgetRef.current.close();
        widgetRef.current = null;
      }
    };
  }, [word]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-3 px-4 flex justify-between items-center border-b border-slate-100">
          <h3 className="font-bold text-slate-800 text-sm">YouGlish — {word}</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-4 min-h-[200px]">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-slate-400" />
            </div>
          )}
          {noResults && (
            <div className="flex items-center justify-center py-16 text-slate-400 text-sm">
              No results found for &ldquo;{word}&rdquo;
            </div>
          )}
          <div id="youglish-widget"></div>
        </div>
      </div>
    </div>
  );
};
