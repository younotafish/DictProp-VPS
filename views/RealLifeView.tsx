import React, { useMemo, useState } from 'react';
import type { ReviewRating, StoredItem } from '../types';
import { REAL_LIFE_COLLECTIONS } from '../services/realLifeCatalog';
import { indexRealLifeProgress } from '../services/realLifeProgress';
import { useNow } from '../hooks/useNow';
import { RealLifeIndex } from './reading/RealLifeIndex';
import { RealLifeCollectionScreen } from './reading/RealLifeCollectionScreen';

interface RealLifeViewProps {
  onOpenSentence: (ordered: StoredItem[], index: number) => void;
  progressItems: StoredItem[];
  onUpdateSRS: (
    itemId: string,
    rating?: ReviewRating,
    context?: { seedItem?: StoredItem },
  ) => void | Promise<boolean>;
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
  const now = useNow(progressItems);
  const progressIndex = useMemo(() => indexRealLifeProgress(progressItems), [progressItems]);

  if (!selectedCollection) {
    return (
      <RealLifeIndex
        progressIndex={progressIndex}
        now={now}
        onOpenCollection={setSelectedCollectionId}
        onScroll={onScroll}
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
      onOpenSentence={onOpenSentence}
      onUpdateSRS={onUpdateSRS}
      isSentenceSaved={isSentenceSaved}
      onScroll={onScroll}
      findSaved={findSaved}
      onOpenCard={onOpenCard}
    />
  );
};
