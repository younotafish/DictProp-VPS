import React, { useCallback, useDeferredValue, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookmarkCheck,
  Check,
  CheckCircle2,
  ExternalLink,
  Play,
  Search,
  X,
} from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import type { ReviewRating, StoredItem } from '../../types';
import { HighlightedSentence } from '../../components/HighlightedSentence';
import { SentenceSpeakerButton } from '../../components/SentenceSpeakerButton';
import { SRSAlgorithm } from '../../services/srsAlgorithm';
import type { RealLifeCollection, RealLifeSentence } from '../../services/realLifeCatalog';
import { buildRealLifeStudyItems, createRealLifeProgressItem } from '../../services/realLifeProgress';
import { realLifeProgressItemId } from '../../services/realLifeProgressIdentity';
import { sentencesToStudy, summarizeCatalogProgress, type CatalogProgressIndex } from '../../services/catalogProgress';
import type { SentenceReviewFilter } from '../../services/sentenceOrdering';
import { sentenceReviewState } from '../../services/sentenceReviewState';
import { useLatest } from '../../hooks/useStableValue';
import { collectionStyle } from './realLifeStyle';
import { filterRealLifeSentences } from './realLifeFilter';

const sentenceKey = (_index: number, sentence: RealLifeSentence) => sentence.id;
const listComponents = { Footer: () => <div className="h-[calc(6rem+env(safe-area-inset-bottom))]" /> };

interface RealLifeSentenceRowProps {
  sentence: RealLifeSentence;
  /** The collection's accent, for the position badge. */
  softClass: string;
  saved: boolean;
  reviewed: boolean;
  actionable: boolean;
  masteryPercent: number;
  onOpen: (sentence: RealLifeSentence) => void;
  onMarkReviewed: (sentence: RealLifeSentence) => void;
  findSaved?: (term: string) => StoredItem | null;
  onOpenCard?: (item: StoredItem) => void;
}

/** A line of a collection. Rows re-render only when their own sentence or progress changes, not for every
 *  keystroke in the search box or every change elsewhere in the library. */
const RealLifeSentenceRow = React.memo(function RealLifeSentenceRow({
  sentence,
  softClass,
  saved,
  reviewed,
  actionable,
  masteryPercent,
  onOpen,
  onMarkReviewed,
  findSaved,
  onOpenCard,
}: RealLifeSentenceRowProps) {
  return (
    <div className="mx-auto w-full max-w-5xl px-3 pt-2 sm:px-4">
      <article
        role="button"
        tabIndex={0}
        onClick={() => onOpen(sentence)}
        onKeyDown={event => {
          // Keys pressed on the buttons inside the row are theirs: Enter on Reviewed mustn't open the lesson too.
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ') || event.repeat) return;
          event.preventDefault();
          // The lesson this opens listens for Enter and Space on window too; it mustn't take this press as well.
          event.stopPropagation();
          onOpen(sentence);
        }}
        className="group cursor-pointer rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm transition-all hover:border-indigo-200 hover:shadow-md sm:p-4"
        title="Open the full sentence lesson"
      >
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 flex h-7 min-w-7 shrink-0 items-center justify-center rounded-lg px-1 text-[10px] font-bold tabular-nums ${softClass}`}>
            {sentence.position}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-relaxed text-slate-800 sm:text-base">
              <HighlightedSentence
                text={sentence.markedText}
                itemWord={sentence.focus}
                findSaved={findSaved}
                onOpenCard={onOpenCard}
              />
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <span className="truncate text-[11px] font-semibold text-slate-400">{sentence.sectionTitle}</span>
              {saved && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-600">
                  <BookmarkCheck size={11} /> Saved
                </span>
              )}
              {reviewed ? (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                  <CheckCircle2 size={11} /> {masteryPercent}%
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">Unreviewed</span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {actionable && (
                  <button
                    type="button"
                    onClick={event => { event.stopPropagation(); onMarkReviewed(sentence); }}
                    className="flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700 transition-colors hover:bg-emerald-100"
                    title="Mark as reviewed"
                  >
                    <Check size={12} /> Reviewed
                  </button>
                )}
                <SentenceSpeakerButton text={sentence.text} className="rounded-full p-1.5 hover:bg-indigo-50" iconSize={15} />
                <ArrowRight size={15} className="text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-400" />
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
});

interface RealLifeCollectionScreenProps {
  collection: RealLifeCollection;
  progressIndex: CatalogProgressIndex;
  now: number;
  onClose: () => void;
  onOpenSentence: (ordered: StoredItem[], index: number) => void;
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

/**
 * A collection's lines, narrowed by theme, review state and search, and Study for the lines still to review. Its
 * parent mounts it afresh for each collection opened, so every collection starts on All with an empty search.
 */
export function RealLifeCollectionScreen({
  collection,
  progressIndex,
  now,
  onClose,
  onOpenSentence,
  onUpdateSRS,
  isSentenceSaved,
  onScroll,
  findSaved,
  onOpenCard,
}: RealLifeCollectionScreenProps) {
  const [sectionId, setSectionId] = useState('all');
  const [reviewFilter, setReviewFilter] = useState<SentenceReviewFilter>('all');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const progress = useMemo(
    () => summarizeCatalogProgress(collection.sentences, progressIndex, now),
    [collection, now, progressIndex],
  );

  const filtered = useMemo(
    () => filterRealLifeSentences(collection.sentences, { sectionId, reviewFilter, query: deferredQuery }, progressIndex, now),
    [deferredQuery, now, progressIndex, reviewFilter, sectionId, collection],
  );

  const openSentence = (ordered: readonly RealLifeSentence[], index: number) => {
    onOpenSentence(buildRealLifeStudyItems(ordered, progressIndex, Date.now()), index);
  };

  const startStudy = () => {
    openSentence(sentencesToStudy(collection.sentences, progressIndex, now), 0);
  };

  // Row callbacks stay stable, so typing in the search box doesn't re-render the rows on screen.
  const latest = useLatest({ filtered, openSentence });
  const openFromList = useCallback((sentence: RealLifeSentence) => {
    const { filtered, openSentence } = latest.current;
    openSentence(filtered, filtered.indexOf(sentence));
  }, [latest]);
  const markReviewed = useCallback((sentence: RealLifeSentence) => {
    void onUpdateSRS(realLifeProgressItemId(sentence.id), 'good', { seedItem: createRealLifeProgressItem(sentence) });
  }, [onUpdateSRS]);
  const softClass = collectionStyle[collection.accent].soft;
  const renderSentence = useCallback((_index: number, sentence: RealLifeSentence) => {
    const progressItem = progressIndex.get(sentence.id);
    const state = sentenceReviewState(progressItem?.srs, now);
    return (
      <RealLifeSentenceRow
        sentence={sentence}
        softClass={softClass}
        saved={isSentenceSaved(sentence.text)}
        reviewed={state !== 'unreviewed'}
        actionable={state !== 'memorized'}
        masteryPercent={progressItem?.srs ? Math.round(SRSAlgorithm.getMasteryLevel(progressItem.srs).percentage) : 0}
        onOpen={openFromList}
        onMarkReviewed={markReviewed}
        findSaved={findSaved}
        onOpenCard={onOpenCard}
      />
    );
  }, [now, progressIndex, softClass, isSentenceSaved, openFromList, markReviewed, findSaved, onOpenCard]);

  const style = collectionStyle[collection.accent];
  const CollectionIcon = style.icon;

  // An empty list names what emptied it, the search, the review filter or the theme, and offers to clear each.
  const shownQuery = deferredQuery.trim();
  const filtersActive = reviewFilter !== 'all' || sectionId !== 'all';
  const emptyScope = [
    'No',
    reviewFilter === 'all' ? '' : reviewFilter,
    'conversations',
    sectionId === 'all' ? '' : `in ${collection.sections.find(section => section.id === sectionId)?.title ?? 'this theme'}`,
  ].filter(Boolean).join(' ');

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <header className="z-10 shrink-0 border-b border-slate-200 bg-white px-3 pb-3 pt-3 sm:px-4">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
              title="Back to Real Life collections"
              aria-label="Back to Real Life collections"
            >
              <ArrowLeft size={19} />
            </button>
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${style.soft}`}>
              <CollectionIcon size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <h1 className="truncate text-base font-bold text-slate-900 sm:text-lg">{collection.title}</h1>
                <span className="shrink-0 text-xs font-medium text-slate-400">{collection.sentences.length}</span>
              </div>
              <p className="truncate text-[11px] text-slate-500 sm:text-xs">{collection.description}</p>
            </div>
            <span className={`hidden rounded-full px-2.5 py-1 text-xs font-bold sm:inline-flex ${style.soft}`}>
              {collection.level}
            </span>
            <button
              type="button"
              onClick={startStudy}
              className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl bg-slate-900 px-3 text-xs font-bold text-white transition-colors hover:bg-slate-700"
              title={`Study ${collection.title}`}
            >
              <Play size={14} fill="currentColor" /> Study
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-slate-50 px-3 py-2 text-center">
            <div><p className="text-sm font-bold text-slate-800">{progress.masteryScore}%</p><p className="text-[10px] text-slate-400">mastery</p></div>
            <div><p className="text-sm font-bold text-slate-800">{progress.reviewed}/{progress.total}</p><p className="text-[10px] text-slate-400">reviewed</p></div>
            <div><p className="text-sm font-bold text-orange-600">{progress.toReview}</p><p className="text-[10px] text-slate-400">to review</p></div>
          </div>

          <div className="relative mt-3">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }}
              placeholder={`Search ${collection.title.toLocaleLowerCase('en-US')}…`}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-9 text-sm text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white"
              autoComplete="off"
              autoCapitalize="off"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-0.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-600"
                title="Clear search"
                aria-label="Clear search"
              >
                <X size={15} />
              </button>
            )}
          </div>

          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
            {([
              ['all', 'All', progress.total],
              ['unreviewed', 'Unreviewed', progress.unreviewed],
              ['due', 'Due', progress.due],
              ['memorized', 'Memorized', progress.memorized],
            ] as [SentenceReviewFilter, string, number][]).map(([key, label, count]) => (
              <button
                type="button"
                key={key}
                onClick={() => setReviewFilter(key)}
                className={`inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-semibold transition-colors ${reviewFilter === key ? style.active : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                {label} <span className={reviewFilter === key ? 'text-white/70' : 'text-slate-400'}>{count}</span>
              </button>
            ))}
          </div>

          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
            <button
              type="button"
              onClick={() => setSectionId('all')}
              className={`inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-semibold transition-colors ${sectionId === 'all' ? style.active : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              All {collection.sentences.length}
            </button>
            {collection.sections.map(section => (
              <button
                type="button"
                key={section.id}
                onClick={() => setSectionId(section.id)}
                className={`inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-semibold transition-colors ${sectionId === section.id ? style.active : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                title={section.description}
              >
                {section.title} <span className={sectionId === section.id ? 'text-white/70' : 'text-slate-400'}>{section.sentences.length}</span>
              </button>
            ))}
          </div>

          {collection.sourceNote && (
            <details className="mt-2 rounded-xl border border-amber-100 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-950">
              <summary className="cursor-pointer font-bold">Methodology &amp; public sources</summary>
              <p className="mt-1.5 leading-relaxed text-amber-900/80">{collection.sourceNote}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {collection.sourceLinks?.map(link => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-amber-800 hover:text-amber-950 hover:underline"
                  >
                    {link.label} <ExternalLink size={10} />
                  </a>
                ))}
              </div>
            </details>
          )}
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
          <Search size={42} className="mb-3 text-slate-200" />
          <p className="text-sm font-medium text-slate-500">
            {shownQuery ? `${emptyScope} match “${shownQuery}”` : emptyScope}
          </p>
          <div className="mt-1 flex gap-4">
            {query && (
              <button type="button" onClick={() => setQuery('')} className="min-h-8 text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                Clear search
              </button>
            )}
            {filtersActive && (
              <button type="button" onClick={() => { setReviewFilter('all'); setSectionId('all'); }} className="min-h-8 text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                Show all conversations
              </button>
            )}
          </div>
        </div>
      ) : (
        <Virtuoso
          className="min-h-0 flex-1"
          data={filtered}
          overscan={400}
          onScroll={onScroll as any}
          components={listComponents}
          computeItemKey={sentenceKey}
          itemContent={renderSentence}
        />
      )}
    </div>
  );
}
