import React from 'react';
import { NoticePill } from './NoticePill';
import type { BatchImportStatus } from '../hooks/useBatchImport';
import type { SpeechBackfill } from '../hooks/useSpeechBackfill';
import { count, type JobNotice } from '../services/jobNotices';

/**
 * The background jobs' pills in the notice stack (components/AppStatus). App renders them into the stack's progress
 * group only while one shows, and their code loads with the notebook tools after the first screen, so none of it is
 * in the app's first chunk.
 */

/** The speech sweep's progress line, with its rough time left. */
const describeSpeechGeneration = ({ current, total }: { current: number; total: number }): string => {
  const rem = total - current;
  if (rem <= 0) return `Generating sentence audio · ${current}/${total}`;
  const mins = Math.ceil((rem * 2.75) / 4 / 60);
  return `Generating sentence audio · ${current}/${total} · ~${mins}m left`;
};

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

export interface JobPillsProps {
  ttsGenProgress: SpeechBackfill['ttsGenProgress'];
  onStopSpeechGeneration: () => void;
  /** A batch import under way, which the pill's × stops. */
  batchImportProgress: BatchImportStatus | null;
  onStopBatchImport: () => void;
  /** A background job's result (services/jobNotices), with Retry when it offers one, and a × that dismisses it. */
  jobNotice: JobNotice | null;
  onRetryJob: (notice: JobNotice) => void;
  onDismissJobNotice: () => void;
}

/** The progress group's job pills, in order: the speech sweep, a batch import, then the last job's result. */
export const JobPills: React.FC<JobPillsProps> = ({
  ttsGenProgress, onStopSpeechGeneration, batchImportProgress, onStopBatchImport, jobNotice, onRetryJob,
  onDismissJobNotice,
}) => (
  <>
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
    {batchImportProgress && <BatchImportPill status={batchImportProgress} onStop={onStopBatchImport} />}
    {jobNotice && (
      <NoticePill
        tone={jobNotice.tone}
        role={jobNotice.tone === 'rose' ? 'alert' : 'status'}
        actions={[
          // A batch import's Retry waits for the import under way to end.
          ...(jobNotice.retryWords
            ? [{ label: 'Retry', onClick: () => onRetryJob(jobNotice), disabled: batchImportProgress !== null }]
            : []),
          { label: 'Dismiss this notice', title: 'Dismiss', dismiss: true, onClick: onDismissJobNotice },
        ]}
      >
        {jobNotice.text}
      </NoticePill>
    )}
  </>
);
