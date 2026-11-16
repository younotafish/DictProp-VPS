import React from 'react';
import { NoticePill } from './NoticePill';
import type { SpeechBackfill } from '../hooks/useSpeechBackfill';

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

export interface JobPillsProps {
  ttsGenProgress: SpeechBackfill['ttsGenProgress'];
  onStopSpeechGeneration: () => void;
}

/** The progress group's job pills. */
export const JobPills: React.FC<JobPillsProps> = ({ ttsGenProgress, onStopSpeechGeneration }) => (
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
  </>
);
