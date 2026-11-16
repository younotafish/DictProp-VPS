import React from 'react';
import { WifiOff } from 'lucide-react';
import { AppUpdateToast } from './AppUpdateToast';
import { NoticePill } from './NoticePill';
import { noticeSlotRef } from './noticeSlots';
import { RefusedReviewsNotice } from './RefusedReviews';
import type { ImagePrefetchProgress, ImageRestoreProgress } from '../hooks/useOfflineImages';

// The app-wide notices: the stack of pills that floats at the bottom of the screen.

const describeImageRestore = ({ phase, done, total, failed }: ImageRestoreProgress): string => {
  if (phase === 'checking') return 'Checking which images the server is missing…';
  if (phase === 'uploading') return `Restoring images to server: ${done}/${total}`;
  if (phase === 'failed') return 'Couldn\u2019t restore images. Try again later.';
  if (total === 0) return 'All images already on the server ✓';
  return failed ? `Restored ${total - failed} of ${total} images; ${failed} failed` : `Restored ${total} images to the server ✓`;
};

interface AppStatusPillsProps {
  userId: string;
  onViewRefusedReviews: () => void;
  imagePrefetchProgress: ImagePrefetchProgress | null;
  onStopImageDownload: () => void;
  imageRestoreProgress: ImageRestoreProgress | null;
  /** The background jobs' pills (components/JobPills), which App renders, from their own chunk, only while one shows. */
  jobPills: React.ReactNode;
  undoMessage: string | null;
  onUndo: () => void;
  /** This device couldn't save the library, so the couldn't-save alert shows, everywhere. */
  writeFailed: boolean;
  /** An outage has settled (useOnlineStatus's offlineSettled), which the couldn't-save alert's advice follows. */
  offline: boolean;
  /** The Offline chip shows (services/connectivityNotice): an outage has settled and nothing covers the tabs. */
  offlineChip: boolean;
  /**
   * The tabs show, with the tab bar: the stack floats just above the bar (src/index.css's --nav-h) and above a footer
   * the visible tab sets (--tab-footer-h, Study's grade row). Otherwise a card covers the bar, and the stack starts at
   * --card-float-bottom, as everything floating over a card does.
   */
  aboveTabBar: boolean;
  /** An open card or the card popup covers the page, so a new version's reload offer waits for it to close. */
  holdUpdate: boolean;
  /**
   * The card popup is open and a notice the user has to reach over it shows (the undo offer, the couldn't-save alert):
   * the stack rises above the popup. Otherwise it stays beneath the popup and every dialog.
   */
  liftAbovePopup: boolean;
}

/**
 * The notice stack: the app's pills, floating above the page in one column centred at the bottom that remains
 * visible across tabs and views, so a notice arriving or leaving never moves the page. The stack grows upward and
 * keeps its pills in order of how long they stay, so one coming or going moves only the shorter-lived ones above
 * it: short-lived on top (the undo offer, then the search status line's slot), then progress (a session's preload
 * slot, the background jobs and Sync now, then the result of the last job to end), then the long-lived notices at
 * the bottom (the couldn't-save alert, the Offline chip, refused reviews, then the update).
 * Both slots are always rendered, under the same parent: the notices that portal into them would vanish with a slot
 * rendered conditionally or moved. On the tabs the stack floats above the tab bar, so it never covers a tab; over a card
 * it starts where the card's floating controls end.
 */
export const AppStatusPills: React.FC<AppStatusPillsProps> = ({
  userId, onViewRefusedReviews, imagePrefetchProgress, onStopImageDownload, imageRestoreProgress, jobPills, undoMessage,
  onUndo, writeFailed, offline, offlineChip, aboveTabBar, holdUpdate, liftAbovePopup,
}) => (
  <div className={`fixed ${aboveTabBar ? 'bottom-[calc(var(--nav-h)+var(--tab-footer-h,0px)+0.5rem)]' : 'bottom-[var(--card-float-bottom)]'} left-1/2 -translate-x-1/2 ${liftAbovePopup ? 'z-[110]' : 'z-[80]'} flex flex-col items-center gap-2 pointer-events-none`}>
    {undoMessage && (
      <NoticePill tone="dark" actions={[{ label: 'Undo', onClick: onUndo, keyShortcuts: 'Meta+Z Control+Z' }]}>{undoMessage}</NoticePill>
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
    {jobPills}

    {writeFailed && (
      <NoticePill tone="rose" role="alert" wrap>
        {offline
          ? 'Couldn\u2019t save on this device. Keep this tab open until you\u2019re back online.'
          : 'Couldn\u2019t save on this device. Your changes still sync.'}
      </NoticePill>
    )}
    {offlineChip && <NoticePill tone="amber" icon={<WifiOff size={16} className="shrink-0" />}>Offline</NoticePill>}
    <RefusedReviewsNotice userId={userId} onView={onViewRefusedReviews} />
    <AppUpdateToast hold={holdUpdate} />
  </div>
);
