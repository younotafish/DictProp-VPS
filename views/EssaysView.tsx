import React, { useMemo, useState } from 'react';
import type { StoredItem } from '../types';
import { indexEssayProgress } from '../services/essayProgress';
import { useNow } from '../hooks/useNow';
import { useEssayCatalog } from './reading/useEssayCatalog';
import { EssayIndex } from './reading/EssayIndex';
import { EssayReader } from './reading/EssayReader';

interface EssaysViewProps {
  onOpenSentence: (ordered: StoredItem[], index: number) => void;
  progressItems: StoredItem[];
  onScroll: (event: React.UIEvent<HTMLElement>) => void;
}

/** The Essays tab: the landing page, or the essay the user opened. */
export const EssaysView: React.FC<EssaysViewProps> = ({ onOpenSentence, progressItems, onScroll }) => {
  const [selectedEssayId, setSelectedEssayId] = useState<string | null>(null);
  const { essays, status, retry } = useEssayCatalog();
  const selectedEssay = essays.find(essay => essay.id === selectedEssayId) ?? null;
  const now = useNow(progressItems);
  const progressIndex = useMemo(() => indexEssayProgress(progressItems), [progressItems]);

  if (!selectedEssay) {
    return (
      <EssayIndex
        essays={essays}
        catalogStatus={status}
        onRetryCatalog={retry}
        progressIndex={progressIndex}
        now={now}
        onOpenEssay={setSelectedEssayId}
        onScroll={onScroll}
      />
    );
  }

  return (
    <EssayReader
      essay={selectedEssay}
      progressIndex={progressIndex}
      now={now}
      onBack={() => setSelectedEssayId(null)}
      onOpenSentence={onOpenSentence}
      onScroll={onScroll}
    />
  );
};
