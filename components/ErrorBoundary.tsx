import React from 'react';
import { isChunkLoadError, reloadApp } from '../services/appUpdate';
import { Modal } from './Modal';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onReset?: () => void;
  fallbackMessage?: string;
  /** "fullscreen" (default) shows a fixed overlay; "screen" fills a tab, leaving the navigation usable; "inline" shows a card-sized fallback;
   *  "overlay" shows a dialog over the app for a popup that failed, whose Close calls onReset and tries again.
   *  A popup whose code couldn't be fetched closes at once instead: the update notice offers the reload that fetches it */
  variant?: 'fullscreen' | 'screen' | 'inline' | 'overlay';
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary — catches unhandled render exceptions and displays
 * a recovery UI instead of crashing the entire app with a white screen.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  private recoverButton = React.createRef<HTMLButtonElement>();

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught render error:', error, info.componentStack);
    if (this.props.variant === 'overlay' && isChunkLoadError(error)) this.props.onReset?.();
    // The full-screen fallback covers whatever had focus, so it takes focus itself.
    if ((this.props.variant ?? 'fullscreen') === 'fullscreen') this.recoverButton.current?.focus({ preventScroll: true });
  }

  // Saves and sends what the app still holds first, when the app is still there to do it.
  handleReload = () => {
    void reloadApp();
  };

  handleRecover = () => {
    if (this.props.onReset) {
      this.props.onReset();
    }
    // Clear potentially corrupted persisted state
    try {
      localStorage.removeItem('app_detail_context');
    } catch {}
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.variant === 'overlay') {
        // React keeps a failed lazy import's error, so trying again would only fail again.
        if (isChunkLoadError(this.state.error)) return null;
        return (
          <Modal onClose={this.handleRecover} maxWidth="max-w-sm" ariaLabel="Something went wrong">
            <div className="p-6 text-center">
              <h2 className="text-lg font-bold text-slate-800 mb-2">Something went wrong</h2>
              <p className="text-sm text-slate-500 mb-6 leading-relaxed">
                {this.props.fallbackMessage || 'This couldn\u2019t be displayed. Your data is safe.'}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={this.handleRecover}
                  className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-xl transition-colors"
                >
                  Close
                </button>
                <button
                  onClick={this.handleReload}
                  className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors"
                >
                  Reload App
                </button>
              </div>
            </div>
          </Modal>
        );
      }

      if (this.props.variant === 'inline') {
        return (
          <div className="bg-slate-50 rounded-2xl border border-slate-200 p-6 text-center">
            <p className="text-sm text-slate-500 mb-3">
              {this.props.fallbackMessage || 'This content couldn\u2019t be displayed.'}
            </p>
            <button
              onClick={this.handleRecover}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-xl transition-colors"
            >
              Try Again
            </button>
          </div>
        );
      }

      return (
        <div className={this.props.variant === 'screen'
          ? 'h-full overflow-y-auto bg-slate-50 flex items-center justify-center p-6'
          : 'fixed inset-0 z-50 bg-slate-50 flex items-center justify-center p-6'}>
          <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-sm w-full text-center">
            <div className="w-16 h-16 bg-rose-100 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h2>
            <p className="text-sm text-slate-500 mb-6 leading-relaxed">
              {this.props.fallbackMessage || 'The app encountered an unexpected error. Your data is safe.'}
            </p>
            {this.state.error && (
              <p className="text-xs text-slate-400 bg-slate-50 rounded-lg p-3 mb-6 font-mono break-all text-left">
                {this.state.error.message}
              </p>
            )}
            <div className="flex gap-3">
              <button
                ref={this.recoverButton}
                onClick={this.handleRecover}
                className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-xl transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={this.handleReload}
                className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors"
              >
                Reload App
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
