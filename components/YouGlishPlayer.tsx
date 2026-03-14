import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, AlertCircle } from 'lucide-react';
import { useYouGlishSandbox } from '../hooks/useYouGlishSandbox';

declare global {
  interface Window {
    YG: any;
    onYouglishAPIReady: () => void;
  }
}

interface Props {
  word: string;
  onClose?: () => void;
  /** 'modal' (default): fixed overlay. 'inline': renders in parent flow, no overlay */
  mode?: 'modal' | 'inline';
}

const SCRIPT_LOAD_TIMEOUT = 10000;
const FETCH_TIMEOUT = 15000;

/**
 * Error boundary scoped to YouGlishPlayer — catches render/lifecycle
 * errors from the widget and shows a recovery UI instead of crashing
 * the parent VocabCard / DetailView.
 */
class YouGlishErrorBoundary extends React.Component<
  { children: React.ReactNode; onClose?: () => void; word: string; inline?: boolean },
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
      if (this.props.inline) {
        return (
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-center">
            <AlertCircle size={20} className="text-amber-400 mx-auto mb-1" />
            <p className="text-xs text-slate-500">YouGlish unavailable</p>
          </div>
        );
      }
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

/** Unique ID counter for inline widget instances (avoids DOM id collisions) */
let widgetIdCounter = 0;

const YouGlishPlayerInner: React.FC<Props> = ({ word, onClose, mode = 'modal' }) => {
  useYouGlishSandbox();
  const widgetRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [noResults, setNoResults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [widgetId] = useState(() => `youglish-widget-${++widgetIdCounter}`);
  const isInline = mode === 'inline';

  // Escape key closes modal (only in modal mode)
  useEffect(() => {
    if (isInline || !onClose) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isInline]);

  // Load widget
  useEffect(() => {
    let mounted = true;
    let scriptLoadTimer: ReturnType<typeof setTimeout> | null = null;
    let fetchTimer: ReturnType<typeof setTimeout> | null = null;

    let iframeObserver: MutationObserver | null = null;

    const createWidget = () => {
      if (!mounted || !window.YG) return;

      if (scriptLoadTimer) {
        clearTimeout(scriptLoadTimer);
        scriptLoadTimer = null;
      }

      try {
        setLoading(false);

        // For inline mode, measure parent container width; for modal use fixed width
        const width = isInline
          ? (containerRef.current?.clientWidth || 400)
          : Math.min(600, window.innerWidth - 48);

        // Watch for iframes created by the widget and add autoplay permission
        // so the browser allows the embedded YouTube player to autoplay
        const widgetContainer = document.getElementById(widgetId);
        if (widgetContainer) {
          iframeObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of Array.from(mutation.addedNodes)) {
                if (node instanceof HTMLIFrameElement) {
                  node.allow = 'autoplay; encrypted-media';
                }
                if (node instanceof HTMLElement) {
                  node.querySelectorAll('iframe').forEach(iframe => {
                    iframe.allow = 'autoplay; encrypted-media';
                  });
                }
              }
            }
          });
          iframeObserver.observe(widgetContainer, { childList: true, subtree: true });
        }

        widgetRef.current = new window.YG.Widget(widgetId, {
          width,
          components: 8 + 16 + 64, // caption + speed + controls
          autoStart: 1,
          events: {
            'onFetchDone': (e: any) => {
              if (!mounted) return;
              if (fetchTimer) {
                clearTimeout(fetchTimer);
                fetchTimer = null;
              }
              if (e.totalResult === 0) setNoResults(true);
            },
            'onError': () => {
              if (!mounted) return;
              if (fetchTimer) {
                clearTimeout(fetchTimer);
                fetchTimer = null;
              }
              setError('YouGlish playback error.');
            }
          }
        });
        widgetRef.current.fetch(word, 'english', 'us');

        fetchTimer = setTimeout(() => {
          if (mounted && loading) {
            setLoading(false);
            setError('YouGlish took too long to respond.');
          }
        }, FETCH_TIMEOUT);
      } catch (e) {
        if (!mounted) return;
        setLoading(false);
        setError('Failed to initialize YouGlish.');
      }
    };

    if (window.YG) {
      createWidget();
    } else {
      window.onYouglishAPIReady = createWidget;
      // Only add script if not already present
      if (!document.querySelector('script[src*="youglish.com"]')) {
        const script = document.createElement('script');
        script.src = 'https://youglish.com/public/emb/widget.js';
        script.charset = 'utf-8';
        script.onerror = () => {
          if (!mounted) return;
          setLoading(false);
          setError('Failed to load YouGlish.');
        };
        document.head.appendChild(script);
      }

      scriptLoadTimer = setTimeout(() => {
        if (mounted && loading) {
          setLoading(false);
          setError('YouGlish is taking too long to load.');
        }
      }, SCRIPT_LOAD_TIMEOUT);
    }

    return () => {
      mounted = false;
      if (iframeObserver) iframeObserver.disconnect();
      if (scriptLoadTimer) clearTimeout(scriptLoadTimer);
      if (fetchTimer) clearTimeout(fetchTimer);
      if (widgetRef.current) {
        try { widgetRef.current.close(); } catch (_) {}
        widgetRef.current = null;
      }
      const el = document.getElementById(widgetId);
      if (el) el.innerHTML = '';
    };
  }, [word, widgetId]);

  // Inline mode: render in parent flow
  if (isInline) {
    return (
      <div ref={containerRef} className="mt-3 rounded-xl overflow-hidden border border-slate-200 bg-white">
        {loading && (
          <div className="flex items-center justify-center py-6 gap-2">
            <Loader2 size={16} className="animate-spin text-slate-400" />
            <span className="text-xs text-slate-400">Loading YouGlish...</span>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center py-4 gap-2 text-center">
            <AlertCircle size={16} className="text-amber-400 shrink-0" />
            <p className="text-xs text-slate-500">{error}</p>
          </div>
        )}
        {noResults && !error && (
          <div className="flex items-center justify-center py-4 gap-2">
            <p className="text-xs text-slate-400">No YouGlish results for &ldquo;{word}&rdquo;</p>
          </div>
        )}
        <div id={widgetId} className={error ? 'hidden' : ''}></div>
      </div>
    );
  }

  // Modal mode: fixed overlay
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
          <div id={widgetId} className={error ? 'hidden' : ''}></div>
        </div>
      </div>
    </div>
  );
};

/** Public export — wraps the player in an error boundary so crashes never propagate to VocabCard */
export const YouGlishPlayer: React.FC<Props> = ({ word, onClose, mode = 'modal' }) => (
  <YouGlishErrorBoundary onClose={onClose} word={word} inline={mode === 'inline'}>
    <YouGlishPlayerInner word={word} onClose={onClose} mode={mode} />
  </YouGlishErrorBoundary>
);
