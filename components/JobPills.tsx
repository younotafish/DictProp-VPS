import React from 'react';
import { NoticePill, type NoticeAction } from './NoticePill';
import type { BatchImportStatus } from '../hooks/useBatchImport';
import type { SpeechProgress } from '../hooks/useSpeechBackfill';
import { count, forceSyncText, type ForceSyncPhase, type JobNotice } from '../services/jobNotices';

/**
 * The background jobs' pills in the notice stack (components/AppStatus). App renders them into the stack's progress
 * group only while one shows, and their code loads with the notebook tools after the first screen, so none of it is
 * in the app's first chunk.
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
