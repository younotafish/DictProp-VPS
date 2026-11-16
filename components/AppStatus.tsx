import React from 'react';
import { AppUpdateToast } from './AppUpdateToast';
import { NoticePill } from './NoticePill';
import { noticeSlotRef } from './noticeSlots';
import { RefusedReviewsNotice } from './RefusedReviews';
import type { ImagePrefetchProgress, ImageRestoreProgress } from '../hooks/useOfflineImages';
import type { SpeechBackfill } from '../hooks/useSpeechBackfill';

// The app-wide notices: banners across the top, and the stack of pills that floats at the bottom.

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
  userId: string;
  onViewRefusedReviews: () => void;
  imagePrefetchProgress: ImagePrefetchProgress | null;
  onStopImageDownload: () => void;
  imageRestoreProgress: ImageRestoreProgress | null;
  ttsGenProgress: SpeechBackfill['ttsGenProgress'];
  onStopSpeechGeneration: () => void;
  undoMessage: string | null;
  onUndo: () => void;
  /**
   * The tabs show, with the tab bar: the stack floats just above the bar (src/index.css's --nav-h) and above a footer
   * the visible tab sets (--tab-footer-h, Study's grade row). Otherwise a card covers the bar, and the stack starts at
   * --card-float-bottom, as everything floating over a card does.
   */
  aboveTabBar: boolean;
}

/** The speech sweep's progress line, with its rough time left. */
const describeSpeechGeneration = ({ current, total }: { current: number; total: number }): string => {
  const rem = total - current;
  if (rem <= 0) return `Generating sentence audio · ${current}/${total}`;
  const mins = Math.ceil((rem * 2.75) / 4 / 60);
  return `Generating sentence audio · ${current}/${total} · ~${mins}m left`;
};

/**
 * The notice stack: the app's pills, floating above the page in one column centred at the bottom that remains
 * visible across tabs and views, so a notice arriving or leaving never moves the page. The stack grows upward and
 * keeps its pills in order of how long they stay, so one coming or going moves only the shorter-lived ones above
 * it: short-lived on top (the undo offer, then the search status line's slot), then progress (a session's preload
 * slot, then the background jobs), then the long-lived notices at the bottom (refused reviews, then the update).
 * Both slots are always rendered, under the same parent: the notices that portal into them would vanish with a slot
 * rendered conditionally or moved. On the tabs the stack floats above the tab bar, so it never covers a tab; over a card
 * it starts where the card's floating controls end. An undo offer lifts it above the card popup.
 */
export const AppStatusPills: React.FC<AppStatusPillsProps> = ({
  userId, onViewRefusedReviews, imagePrefetchProgress, onStopImageDownload, imageRestoreProgress,
  ttsGenProgress, onStopSpeechGeneration, undoMessage, onUndo, aboveTabBar,
}) => (
  <div className={`fixed ${aboveTabBar ? 'bottom-[calc(var(--nav-h)+var(--tab-footer-h,0px)+0.5rem)]' : 'bottom-[var(--card-float-bottom)]'} left-1/2 -translate-x-1/2 ${undoMessage ? 'z-[110]' : 'z-[80]'} flex flex-col items-center gap-2 pointer-events-none`}>
    {undoMessage && (
      <NoticePill tone="dark" actions={[{ label: 'Undo', onClick: onUndo }]}>{undoMessage}</NoticePill>
    )}
    <div ref={noticeSlotRef('search')} data-notice-slot="search" className="flex flex-col items-center gap-2 empty:hidden" />

    <div ref={noticeSlotRef('progress')} data-notice-slot="progress" className="flex flex-col items-center gap-2 empty:hidden" />
    {imagePrefetchProgress && (
      <NoticePill
        tone="indigo"
        spinner={imagePrefetchProgress.done < imagePrefetchProgress.total}
        actions={[{ label: 'Stop downloading offline images', title: 'Stop downloading', dismiss: true, onClick: onStopImageDownload }]}
      >
        Offline images · {imagePrefetchProgress.done}/{imagePrefetchProgress.total}
      </NoticePill>
    )}
    {imageRestoreProgress && (
      <NoticePill tone={imageRestoreProgress.phase === 'failed' || imageRestoreProgress.failed ? 'rose' : 'emerald'}>
        {describeImageRestore(imageRestoreProgress)}
      </NoticePill>
    )}
    {ttsGenProgress?.isRunning && (
      <NoticePill
        tone="indigo"
        spinner
        progress={ttsGenProgress.total > 0 ? ttsGenProgress.current / ttsGenProgress.total : 0}
        actions={[{ label: 'Stop generating sentence audio', title: 'Stop generating', dismiss: true, onClick: onStopSpeechGeneration }]}
      >
        {describeSpeechGeneration(ttsGenProgress)}
      </NoticePill>
    )}

    <RefusedReviewsNotice userId={userId} onView={onViewRefusedReviews} />
    <AppUpdateToast />
  </div>
);
