import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { StoredItem } from '../types';
import { indexEssayProgress } from '../services/essayProgress';
import { useListClock } from '../hooks/useNow';
import { useEssayCatalog } from './reading/useEssayCatalog';
import { EssayIndex } from './reading/EssayIndex';
import { EssayReader } from './reading/EssayReader';
import { nextReading } from './reading/essayGroups';

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
  // What's due counts from this time, taken again when an essay opens or closes and when a sentence opens over the
  // page, not when progress arrives from a sync.
  const { now, noteOpened } = useListClock(selectedEssayId);
  const progressIndex = useMemo(() => indexEssayProgress(progressItems), [progressItems]);
  const openSentence = useCallback((ordered: StoredItem[], index: number) => {
    onOpenSentence(ordered, index);
    noteOpened();
  }, [onOpenSentence, noteOpened]);
  // Back from an essay finds the landing page scrolled where it was left.
  const landingScroll = useRef(0);

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
        scrollMemory={landingScroll}
      />
    );
  }

  // Each essay mounts afresh, so the next reading opens at its own start rather than at the last one's scroll.
  return (
    <EssayReader
      key={selectedEssay.id}
      essay={selectedEssay}
      progressIndex={progressIndex}
      now={now}
      onBack={() => setSelectedEssayId(null)}
      onOpenSentence={openSentence}
      onScroll={onScroll}
      nextEssay={nextReading(essays, selectedEssay.id)}
      onOpenEssay={setSelectedEssayId}
    />
  );
};
