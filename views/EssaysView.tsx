import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { StoredItem } from '../types';
import { indexEssayProgress } from '../services/essayProgress';
import { readReadingPositions, writeReadingPosition, type ReadingPosition } from '../services/readingPosition';
import { useListClock } from '../hooks/useNow';
import { useEssayCatalog } from './reading/useEssayCatalog';
import { EssayIndex } from './reading/EssayIndex';
import { EssayReader } from './reading/EssayReader';
import { nextReading } from './reading/essayGroups';
import type { LandingScroll } from './reading/landingScroll';

interface EssaysViewProps {
  onOpenSentence: (ordered: StoredItem[], index: number) => void;
  progressItems: StoredItem[];
  onScroll: (event: React.UIEvent<HTMLElement>) => void;
  /**
   * The signed-in user, whose reading positions this device keeps (services/readingPosition): each essay reopens where
   * it was left, and the landing page offers to continue the last one.
   */
  userId: string;
}

/** The Essays tab: the landing page, or the essay the user opened. */
export const EssaysView: React.FC<EssaysViewProps> = ({ onOpenSentence, progressItems, onScroll, userId }) => {
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
  const landingScroll = useRef<LandingScroll>({ scrollTop: 0, cardSpace: 0 });
  // Where each essay was left, read as the tab opens (it opens for one signed-in user), so the Continue card is on the
  // landing page from its first frame.
  const [positions, setPositions] = useState<ReadingPosition[]>(() => readReadingPositions(userId));
  const savePosition = useCallback((entry: ReadingPosition) => {
    setPositions(writeReadingPosition(userId, entry));
  }, [userId]);

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
        readingPositions={positions}
      />
    );
  }

  // Keyed by id, each essay mounts afresh: Next never carries the last reading's scroll over, and the essay opens at the
  // sentence it was left at if it was left unfinished, or else at its title.
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
      initialPosition={positions.find(position => position.id === selectedEssay.id)}
      onSavePosition={savePosition}
    />
  );
};
