import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Loader2, AlertCircle } from 'lucide-react';

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

const SCRIPT_LOAD_TIMEOUT = 10000; // 10s to load the YouGlish script
const FETCH_TIMEOUT = 15000; // 15s to get results after widget creation

/**
 * Error boundary scoped to YouGlishPlayer — catches render/lifecycle
 * errors from the widget and shows a recovery UI instead of crashing
 * the parent VocabCard / DetailView.
 */
class YouGlishErrorBoundary extends React.Component<
  { children: React.ReactNode; onClose: () => void; word: string },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[YouGlish] Widget crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={this.props.onClose}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-3 px-4 flex justify-between items-center border-b border-slate-100">
              <h3 className="font-bold text-slate-800 text-sm">YouGlish — {this.props.word}</h3>
              <button
                onClick={this.props.onClose}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-slate-100 transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-4 min-h-[200px] flex flex-col items-center justify-center gap-3 text-center">
              <AlertCircle size={32} className="text-amber-400" />
              <p className="text-sm text-slate-600">YouGlish encountered an error and couldn't load.</p>
              <button
                onClick={this.props.onClose}
                className="mt-2 px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const YouGlishPlayerInner: React.FC<Props> = ({ word, onClose }) => {
  const widgetRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [noResults, setNoResults] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    let scriptLoadTimer: ReturnType<typeof setTimeout> | null = null;
    let fetchTimer: ReturnType<typeof setTimeout> | null = null;

    const createWidget = () => {
      if (!mounted || !window.YG) return;

      // Clear script load timeout since we got the API
      if (scriptLoadTimer) {
        clearTimeout(scriptLoadTimer);
        scriptLoadTimer = null;
      }

      try {
        setLoading(false);
        widgetRef.current = new window.YG.Widget('youglish-widget', {
          width: Math.min(600, window.innerWidth - 48),
          components: 8 + 16 + 64, // caption + speed + controls
          autoStart: 1,
          events: {
            'onFetchDone': (e: any) => {
              if (!mounted) return;
              // Clear fetch timeout — we got a response
              if (fetchTimer) {
                clearTimeout(fetchTimer);
                fetchTimer = null;
              }
              if (e.totalResult === 0) setNoResults(true);
            },
            'onError': (e: any) => {
              if (!mounted) return;
              if (fetchTimer) {
                clearTimeout(fetchTimer);
                fetchTimer = null;
              }
              setError('YouGlish playback error. Please try again.');
            }
          }
        });
        widgetRef.current.fetch(word, 'english', 'us');

        // Timeout if no results come back
        fetchTimer = setTimeout(() => {
          if (mounted && loading) {
            setLoading(false);
            setError('YouGlish took too long to respond. The service may be unavailable.');
          }
        }, FETCH_TIMEOUT);
      } catch (e) {
        if (!mounted) return;
        setLoading(false);
        setError('Failed to initialize YouGlish widget.');
      }
    };

    if (window.YG) {
      createWidget();
    } else {
      window.onYouglishAPIReady = createWidget;
      const script = document.createElement('script');
      script.src = 'https://youglish.com/public/emb/widget.js';
      script.charset = 'utf-8';
      script.onerror = () => {
        if (!mounted) return;
        setLoading(false);
        setError('Failed to load YouGlish. Check your internet connection.');
      };
      document.head.appendChild(script);

      // Timeout for script loading
      scriptLoadTimer = setTimeout(() => {
        if (mounted && loading) {
          setLoading(false);
          setError('YouGlish is taking too long to load. The service may be blocked or unavailable.');
        }
      }, SCRIPT_LOAD_TIMEOUT);
    }

    return () => {
      mounted = false;
      if (scriptLoadTimer) clearTimeout(scriptLoadTimer);
      if (fetchTimer) clearTimeout(fetchTimer);
      if (widgetRef.current) {
        try { widgetRef.current.close(); } catch (_) {}
        widgetRef.current = null;
      }
      // Clean up any DOM remnants the widget left behind
      const el = document.getElementById('youglish-widget');
      if (el) el.innerHTML = '';
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
            <div className="flex flex-col items-center justify-center py-16 gap-2">
              <Loader2 size={24} className="animate-spin text-slate-400" />
              <span className="text-xs text-slate-400">Loading YouGlish...</span>
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <AlertCircle size={32} className="text-amber-400" />
              <p className="text-sm text-slate-600">{error}</p>
              <button
                onClick={onClose}
                className="mt-2 px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Close
              </button>
            </div>
          )}
          {noResults && !error && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <AlertCircle size={32} className="text-slate-300" />
              <p className="text-sm text-slate-500">
                No pronunciation videos found for &ldquo;{word}&rdquo;
              </p>
              <button
                onClick={onClose}
                className="mt-2 px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Close
              </button>
            </div>
          )}
          <div id="youglish-widget" className={error ? 'hidden' : ''}></div>
        </div>
      </div>
    </div>
  );
};

/** Public export — wraps the player in an error boundary so crashes never propagate to VocabCard */
export const YouGlishPlayer: React.FC<Props> = ({ word, onClose }) => (
  <YouGlishErrorBoundary onClose={onClose} word={word}>
    <YouGlishPlayerInner word={word} onClose={onClose} />
  </YouGlishErrorBoundary>
);
