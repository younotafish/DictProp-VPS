import React from 'react';
import { Loader2, X } from 'lucide-react';
import { AppUpdateToast } from './AppUpdateToast';
import { RefusedReviewsNotice } from './RefusedReviews';

// The app-wide notices: banners across the top, and the pills that float above the navigation.

export interface ImageRestoreProgress { phase: 'checking' | 'uploading' | 'done' | 'failed'; done: number; total: number; failed: number }
const describeImageRestore = ({ phase, done, total, failed }: ImageRestoreProgress): string => {
  if (phase === 'checking') return 'Checking which images the server is missing…';
  if (phase === 'uploading') return `Restoring images to server: ${done}/${total}`;
  if (phase === 'failed') return 'Couldn\u2019t restore images. Try again later.';
  if (total === 0) return 'All images already on the server ✓';
  return failed ? `Restored ${total - failed} of ${total} images; ${failed} failed` : `Restored ${total} images to the server ✓`;
};

export const AppBanners: React.FC<{ showOffline: boolean; writeFailed: boolean; isOnline: boolean }> = ({ showOffline, writeFailed, isOnline }) => (
  <>
    {/* Offline banner */}
    {showOffline && (
      <div className="bg-amber-500 text-white text-center py-2 text-sm font-medium flex items-center justify-center gap-2 shrink-0">
        <span className="inline-block w-2 h-2 bg-white rounded-full animate-pulse" />
        Offline mode — changes will sync when connected
      </div>
    )}
    {writeFailed && (
      <div role="alert" className="bg-rose-600 text-white text-center px-4 py-2 text-sm font-medium shrink-0">
        {isOnline
          ? 'Couldn\u2019t save on this device (storage may be full). Your changes still sync to your account.'
          : 'Couldn\u2019t save on this device (storage may be full). Keep this tab open until you\u2019re back online.'}
      </div>
    )}
  </>
);

interface AppStatusPillsProps {
  userId: string | undefined;
  onViewRefusedReviews: () => void;
  imagePrefetchProgress: { done: number; total: number } | null;
  onStopImageDownload: () => void;
  imageRestoreProgress: ImageRestoreProgress | null;
  ttsGenProgress: { current: number; total: number; isRunning: boolean } | null;
  onStopSpeechGeneration: () => void;
  undoMessage: string | null;
  onUndo: () => void;
}

// Global background-job progress — remains visible across tabs/views. It floats above the nav, so a
// job starting or finishing never moves the page. An undo offer lifts it above the card popup.
export const AppStatusPills: React.FC<AppStatusPillsProps> = ({
  userId, onViewRefusedReviews, imagePrefetchProgress, onStopImageDownload, imageRestoreProgress,
  ttsGenProgress, onStopSpeechGeneration, undoMessage, onUndo,
}) => (
  <div className={`fixed bottom-20 left-1/2 -translate-x-1/2 ${undoMessage ? 'z-[110]' : 'z-[80]'} flex flex-col items-center gap-2 pointer-events-none`}>
    <AppUpdateToast />
    <RefusedReviewsNotice userId={userId} onView={onViewRefusedReviews} />
    {imagePrefetchProgress && (
      <div role="status" className="pointer-events-auto bg-indigo-600 text-white rounded-full shadow-xl px-4 py-2 flex items-center gap-3 fade-in">
        {imagePrefetchProgress.done < imagePrefetchProgress.total && <Loader2 size={16} className="animate-spin shrink-0" />}
        <span className="text-sm font-medium whitespace-nowrap">
          Offline images · {imagePrefetchProgress.done}/{imagePrefetchProgress.total}
        </span>
        <button onClick={onStopImageDownload} className="ml-1 shrink-0 text-indigo-200 hover:text-white" title="Stop downloading" aria-label="Stop downloading offline images">
          <X size={15} />
        </button>
      </div>
    )}
    {imageRestoreProgress && (
      <div role="status" className={`pointer-events-auto text-white rounded-full shadow-xl px-4 py-2 text-sm font-medium whitespace-nowrap fade-in ${
        imageRestoreProgress.phase === 'failed' || imageRestoreProgress.failed ? 'bg-rose-600' : 'bg-emerald-600'
      }`}>
        {describeImageRestore(imageRestoreProgress)}
      </div>
    )}
    {ttsGenProgress?.isRunning && (
      <div role="status" className="pointer-events-auto bg-indigo-600 text-white rounded-full shadow-xl px-4 py-2 flex items-center gap-3 fade-in">
        <Loader2 size={16} className="animate-spin shrink-0" />
        <span className="text-sm font-medium whitespace-nowrap">
          Generating sentence audio · {ttsGenProgress.current}/{ttsGenProgress.total}
          {(() => {
            const rem = ttsGenProgress.total - ttsGenProgress.current;
            if (rem <= 0) return '';
            const mins = Math.ceil((rem * 2.75) / 4 / 60);
            return ` · ~${mins}m left`;
          })()}
        </span>
        <div className="w-16 h-1.5 bg-indigo-400/60 rounded-full overflow-hidden">
          <div
            className="h-full bg-white transition-all duration-300"
            style={{ width: `${ttsGenProgress.total > 0 ? (ttsGenProgress.current / ttsGenProgress.total) * 100 : 0}%` }}
          />
        </div>
        <button
          onClick={onStopSpeechGeneration}
          className="ml-1 shrink-0 text-indigo-200 hover:text-white"
          title="Stop generating"
          aria-label="Stop generating sentence audio"
        >
          <X size={15} />
        </button>
      </div>
    )}
    {undoMessage && (
      <div role="status" className="pointer-events-auto max-w-[calc(100vw-2rem)] bg-slate-800 text-white rounded-full shadow-xl pl-4 pr-1.5 py-1.5 flex items-center gap-2 text-sm font-medium fade-in">
        <span className="truncate">{undoMessage}</span>
        <button onClick={onUndo} className="shrink-0 rounded-full px-3 py-1 font-semibold text-indigo-300 hover:bg-white/10">
          Undo
        </button>
      </div>
    )}
  </div>
);
