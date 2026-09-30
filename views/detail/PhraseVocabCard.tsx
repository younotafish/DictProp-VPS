import React, { useCallback } from 'react';
import type { VocabCard } from '../../types';
import { VocabCardDisplay } from '../../components/VocabCard';

/** A phrase's key-vocabulary card. Its save toggle is bound to the word here, so the memoized card isn't
 *  handed a new function, and rendered again, every time the detail view renders. */
export function PhraseVocabCard({ vocab, onSaveVocab, ...cardProps }: Omit<React.ComponentProps<typeof VocabCardDisplay>, 'data' | 'onSave'> & {
  vocab: VocabCard;
  onSaveVocab: (vocab: VocabCard) => void;
}) {
  const onSave = useCallback(() => onSaveVocab(vocab), [onSaveVocab, vocab]);
  return <VocabCardDisplay {...cardProps} data={vocab} onSave={onSave} />;
}
