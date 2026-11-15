import type { FC } from 'react';
import type { DetailViewProps } from './detail/types';
import { SentenceReviewView } from './detail/SentenceReviewView';
import { WordDetailView } from './detail/WordDetailView';

export type { DetailViewProps } from './detail/types';

/**
 * The card view, in one of two modes fixed for its life: sentence review when `sentenceItems` lists sentences
 * (aligned with `groups`, their source cards), else the word card. App opens each list under a new key, so the
 * mode never changes under a mounted view. With no card to show (no groups, or an empty group) it renders
 * nothing; that's decided out here rather than partway through a view, whose hooks must run in the same order on
 * every render.
 */
export const DetailView: FC<DetailViewProps> = (props) => {
  const { groups, sentenceItems } = props;
  if (!groups?.length || groups.some(group => group.items.length === 0)) return null;
  return sentenceItems?.length
    ? <SentenceReviewView {...props} groups={groups} sentenceItems={sentenceItems} />
    : <WordDetailView {...props} groups={groups} />;
};
