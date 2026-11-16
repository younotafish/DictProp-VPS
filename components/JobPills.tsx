import React, { useEffect, useMemo, useReducer } from 'react';
import { NoticePill, type NoticeAction } from './NoticePill';
import type { BatchImportStatus } from '../hooks/useBatchImport';
import type { Library } from '../hooks/useLibrary';
import { useNow } from '../hooks/useNow';
import type { SpeechProgress } from '../hooks/useSpeechBackfill';
import {
  count, forceSyncText, stuckText, syncNoticeState, type ForceSyncPhase, type JobNotice,
} from '../services/jobNotices';

/**
 * The background jobs' pills in the notice stack (components/AppStatus): their progress, Sync now, the last result,
 * and changes that won't sync. App renders them into the stack's groups only while one shows, and their code loads
 * with the notebook tools after the first screen, so none of it is in the app's first chunk.
 */

/** A batch import under way, with a × that stops it once the words under way are done. */
const BatchImportPill: React.FC<{ status: BatchImportStatus; onStop: () => void }> = ({ status, onStop }) => {
  const { current, total, stopping } = status;
  return (
    <NoticePill
      tone="indigo"
      spinner
      progress={total > 0 ? current / total : 0}
      // Once stopped, the pill says so until the words under way are done.
      actions={stopping
        ? undefined
        : [{ label: 'Stop adding words', title: 'Stop adding', dismiss: true, onClick: onStop }]}
    >
      {`${stopping ? 'Stopping' : 'Adding words'} · ${count(current)}/${count(total)}`}
    </NoticePill>
  );
};

interface JobNoticePillProps {
  notice: JobNotice;
  /** A batch import is running, whose end a batch import's Retry waits for. */
  importing: boolean;
  onRetry: (notice: JobNotice) => void;
  onDismiss: () => void;
}

/** A background job's result: Retry when it offers one, and a × that dismisses it. A failure is an alert. */
const JobNoticePill: React.FC<JobNoticePillProps> = ({ notice, importing, onRetry, onDismiss }) => {
  const dismiss: NoticeAction = { label: 'Dismiss this notice', title: 'Dismiss', dismiss: true, onClick: onDismiss };
  const actions = notice.retryWords || notice.retry
    ? [{ label: 'Retry', onClick: () => onRetry(notice), disabled: !!notice.retryWords && importing }, dismiss]
    : [dismiss];
  return (
    <NoticePill tone={notice.tone} role={notice.tone === 'rose' ? 'alert' : 'status'} actions={actions}>
      {notice.text}
    </NoticePill>
  );
};

export interface JobPillsProps {
  /** The watched speech sweep; its × hides the pill, and the server carries on. */
  speechProgress: SpeechProgress | null;
  onHideSpeechProgress: () => void;
  /** A batch import under way, which the pill's × stops. */
  batchImportProgress: BatchImportStatus | null;
  onStopBatchImport: () => void;
  /** Sync now under way or just ended (useLibrarySync); a failed one's Retry runs it again. */
  forceSync: ForceSyncPhase | null;
  onForceSync: () => void;
  /** A background job's result (services/jobNotices), with Retry when it offers one, and a × that dismisses it. */
  jobNotice: JobNotice | null;
  onRetryJob: (notice: JobNotice) => void;
  onDismissJobNotice: () => void;
}

/** The progress group's job pills, in order: the speech sweep, a batch import, Sync now, then the last job's result. */
export const JobPills: React.FC<JobPillsProps> = ({
  speechProgress, onHideSpeechProgress, batchImportProgress, onStopBatchImport, forceSync, onForceSync, jobNotice,
  onRetryJob, onDismissJobNotice,
}) => (
  <>
    {speechProgress && (
      <NoticePill
        tone="indigo"
        spinner
        progress={speechProgress.total > 0 ? speechProgress.current / speechProgress.total : 0}
        actions={[{
          label: 'Hide sentence audio progress; generation continues on the server', title: 'Hide', dismiss: true,
          onClick: onHideSpeechProgress,
        }]}
      >
        {`Sentence audio · ${count(speechProgress.current)}/${count(speechProgress.total)}`}
      </NoticePill>
    )}
    {batchImportProgress && <BatchImportPill status={batchImportProgress} onStop={onStopBatchImport} />}
    {forceSync && (
      <NoticePill
        tone={forceSync === 'syncing' ? 'indigo' : forceSync === 'done' ? 'emerald' : 'rose'}
        role={forceSync === 'failed' ? 'alert' : 'status'}
        spinner={forceSync === 'syncing'}
        actions={forceSync === 'failed' ? [{ label: 'Retry', onClick: onForceSync }] : undefined}
      >
        {forceSyncText(forceSync)}
      </NoticePill>
    )}
    {jobNotice && (
      <JobNoticePill
        notice={jobNotice}
        importing={batchImportProgress !== null}
        onRetry={onRetryJob}
        onDismiss={onDismissJobNotice}
      />
    )}
  </>
);

export interface StuckSyncPillProps {
  library: Pick<Library, 'savedItems' | 'pushTrouble' | 'countUnsentChanges'>;
  online: boolean;
  /** Pulls what changed and pushes again (useLibrarySync's retrySync). */
  onRetry: () => void;
}

/**
 * Changes that won't sync (services/jobNotices' syncNoticeState): App renders this once two pushes in a row have
 * failed. It shows a minute after the first of them, while online and visible with changes unsent, counting those
 * changes, and is worked out again as the library changes, once its minute has passed and when the page comes back
 * into view.
 */
export const StuckSyncPill: React.FC<StuckSyncPillProps> = ({ library, online, onRetry }) => {
  const { savedItems, pushTrouble, countUnsentChanges } = library;
  const unsent = useMemo(() => countUnsentChanges(savedItems), [countUnsentChanges, savedItems]);
  // The time the pill is judged at, taken again by the recheck and when the page comes back into view (useNow).
  const [rechecks, recheck] = useReducer((n: number) => n + 1, 0);
  const now = useNow(rechecks);
  const { show, recheckAt } = syncNoticeState({
    online, visible: document.visibilityState === 'visible', failures: pushTrouble.failures,
    firstFailureAt: pushTrouble.firstFailureAt, unsent, now,
  });
  // A recheck that lands a moment early takes the time again and waits out the rest.
  useEffect(() => {
    if (recheckAt === null) return;
    const timer = window.setTimeout(recheck, Math.max(0, recheckAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [recheckAt, now]);
  if (!show) return null;
  return <NoticePill tone="amber" actions={[{ label: 'Retry', onClick: onRetry }]}>{stuckText(unsent)}</NoticePill>;
};
