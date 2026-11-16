import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { ReviewRating, StoredItem } from '../types';
import { REAL_LIFE_COLLECTIONS } from '../services/realLifeCatalog';
import { indexRealLifeProgress } from '../services/realLifeProgress';
import { useListClock } from '../hooks/useNow';
import { RealLifeIndex } from './reading/RealLifeIndex';
import { RealLifeCollectionScreen } from './reading/RealLifeCollectionScreen';

interface RealLifeViewProps {
  onOpenSentence: (ordered: StoredItem[], index: number) => void;
  progressItems: StoredItem[];
  onUpdateSRS: (itemId: string, rating?: ReviewRating, context?: { seedItem?: StoredItem }) => Promise<boolean>;
  isSentenceSaved: (text: string) => boolean;
  onScroll: (event: React.UIEvent<HTMLElement>) => void;
  findSaved?: (term: string) => StoredItem | null;
  onOpenCard?: (item: StoredItem) => void;
}

/** The Real Life tab: the collections' landing page, or the collection the user opened. */
export const RealLifeView: React.FC<RealLifeViewProps> = ({
  onOpenSentence,
  progressItems,
  onUpdateSRS,
  isSentenceSaved,
  onScroll,
  findSaved,
  onOpenCard,
}) => {
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);

  const selectedCollection = REAL_LIFE_COLLECTIONS.find(collection => collection.id === selectedCollectionId) ?? null;
  // What's due counts from this time, taken again when a collection opens or closes and when a sentence opens over
  // the list, not when progress arrives from a sync.
  const { now, noteOpened } = useListClock(selectedCollectionId);
  const progressIndex = useMemo(() => indexRealLifeProgress(progressItems), [progressItems]);
  const openSentence = useCallback((ordered: StoredItem[], index: number) => {
    onOpenSentence(ordered, index);
    noteOpened();
  }, [onOpenSentence, noteOpened]);
  // Back from a collection finds the landing page scrolled where it was left.
  const landingScroll = useRef(0);

  if (!selectedCollection) {
    return (
      <RealLifeIndex
        progressIndex={progressIndex}
        now={now}
        onOpenCollection={setSelectedCollectionId}
        onScroll={onScroll}
        scrollMemory={landingScroll}
      />
    );
  }

  return (
    <RealLifeCollectionScreen
      key={selectedCollection.id}
      collection={selectedCollection}
      progressIndex={progressIndex}
      now={now}
      onClose={() => setSelectedCollectionId(null)}
      onOpenSentence={openSentence}
      onUpdateSRS={onUpdateSRS}
      isSentenceSaved={isSentenceSaved}
      onScroll={onScroll}
      findSaved={findSaved}
      onOpenCard={onOpenCard}
    />
  );
};
