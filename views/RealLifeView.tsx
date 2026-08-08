import React, { useDeferredValue, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookmarkCheck,
  Check,
  CheckCircle2,
  BriefcaseBusiness,
  Compass,
  Crown,
  ExternalLink,
  Play,
  Search,
  ShoppingBag,
  Sparkles,
  X,
} from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import type { ReviewRating, StoredItem } from '../types';
import { HighlightedSentence } from '../components/HighlightedSentence';
import { SentenceSpeakerButton } from '../components/SentenceSpeakerButton';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import {
  REAL_LIFE_COLLECTIONS,
  type RealLifeCollection,
  type RealLifeSentence,
} from '../services/realLifeCatalog';
import {
  buildRealLifeStudyItems,
  createRealLifeProgressItem,
  getRealLifeCollectionProgress,
  indexRealLifeProgress,
  realLifeProgressItemId,
  type RealLifeCollectionProgress,
} from '../services/realLifeProgress';
import type { SentenceReviewFilter } from '../services/sentenceOrdering';

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

const collectionStyle = {
  indigo: {
    tile: 'from-indigo-600 via-violet-600 to-sky-500',
    soft: 'bg-indigo-50 text-indigo-700',
    active: 'bg-indigo-600 text-white',
    icon: BriefcaseBusiness,
  },
  emerald: {
    tile: 'from-emerald-600 via-teal-600 to-cyan-500',
    soft: 'bg-emerald-50 text-emerald-700',
    active: 'bg-emerald-600 text-white',
    icon: ShoppingBag,
  },
  amber: {
    tile: 'from-amber-600 via-orange-600 to-rose-500',
    soft: 'bg-amber-50 text-amber-800',
    active: 'bg-amber-600 text-white',
    icon: Crown,
  },
} as const;

const CollectionTile: React.FC<{
  collection: RealLifeCollection;
  progress: RealLifeCollectionProgress;
  onOpen: () => void;
}> = ({ collection, progress, onOpen }) => {
  const style = collectionStyle[collection.accent];
  const Icon = style.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative min-h-[18rem] overflow-hidden rounded-3xl bg-gradient-to-br ${style.tile} p-4 text-left text-white shadow-lg shadow-slate-200 transition-transform hover:-translate-y-0.5 hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:min-h-[20rem] sm:p-6`}
    >
      <div className="absolute -right-12 -top-14 h-40 w-40 rounded-full border border-white/20 bg-white/10" />
      <div className="absolute -bottom-16 -left-10 h-44 w-44 rounded-full border border-white/10 bg-black/5" />
      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-2">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/20 bg-white/15 backdrop-blur-sm sm:h-12 sm:w-12">
            <Icon size={23} />
          </span>
          <span className="rounded-full border border-white/20 bg-white/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider backdrop-blur-sm sm:text-xs">
            {collection.level}
          </span>
        </div>

        <div className="mt-8 sm:mt-10">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/70 sm:text-xs">{collection.eyebrow}</p>
          <h2 className="mt-2 text-xl font-bold leading-tight sm:text-3xl">{collection.title}</h2>
          <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-white/80 sm:text-sm">{collection.description}</p>
          {collection.sourceNote && (
            <span className="mt-3 inline-flex w-fit rounded-full border border-white/20 bg-white/15 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-white/90 sm:text-[10px]">
              Research synthesis
            </span>
          )}
        </div>

        <div className="mt-5 flex flex-wrap gap-1.5">
          {collection.sections.slice(0, 3).map(section => (
            <span key={section.id} className="rounded-full bg-black/10 px-2 py-1 text-[9px] font-semibold text-white/90 sm:text-[11px]">
              {section.title}
            </span>
          ))}
          <span className="rounded-full bg-black/10 px-2 py-1 text-[9px] font-semibold text-white/90 sm:text-[11px]">
            +{collection.sections.length - 3} themes
          </span>
        </div>

        <div className="mt-auto pt-5">
          <div className="mb-4">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold text-white/75 sm:text-xs">
              <span>{progress.reviewed} reviewed</span>
              <span>{progress.masteryScore}% mastery</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-black/15">
              <div
                className="h-full rounded-full bg-white/90 transition-all"
                style={{ width: `${progress.total === 0 ? 0 : Math.round((progress.reviewed / progress.total) * 100)}%` }}
              />
            </div>
          </div>
          <div className="flex items-end justify-between">
          <div>
            <p className="text-2xl font-bold tabular-nums sm:text-3xl">{collection.sentences.length}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-white/70 sm:text-xs">
              {progress.toReview > 0 ? `${progress.toReview} to review` : 'review complete'}
            </p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-800 transition-transform group-hover:translate-x-1">
            <ArrowRight size={18} />
          </span>
          </div>
        </div>
      </div>
    </button>
  );
};

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
  const [sectionId, setSectionId] = useState('all');
  const [reviewFilter, setReviewFilter] = useState<SentenceReviewFilter>('all');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const selectedCollection = REAL_LIFE_COLLECTIONS.find(collection => collection.id === selectedCollectionId) ?? null;
  const now = useMemo(() => Date.now(), [progressItems]);
  const progressBySentence = useMemo(() => indexRealLifeProgress(progressItems), [progressItems]);
  const collectionProgress = useMemo(
    () => new Map(REAL_LIFE_COLLECTIONS.map(collection => [
      collection.id,
      getRealLifeCollectionProgress(collection, progressItems, now),
    ])),
    [now, progressItems],
  );

  const matchesReviewFilter = (sentence: RealLifeSentence, filter: SentenceReviewFilter): boolean => {
    if (filter === 'all') return true;
    const item = progressBySentence.get(sentence.id);
    const reviews = item?.srs?.totalReviews ?? 0;
    if (filter === 'unreviewed') return reviews === 0;
    if (filter === 'due') return reviews > 0 && (item?.srs?.nextReview ?? 0) <= now;
    return reviews > 0 && (item?.srs?.nextReview ?? 0) > now;
  };

  const filtered = useMemo(() => {
    if (!selectedCollection) return [];
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase('en-US');
    return selectedCollection.sentences.filter(sentence => {
      if (sectionId !== 'all' && sentence.sectionId !== sectionId) return false;
      if (!matchesReviewFilter(sentence, reviewFilter)) return false;
      if (!normalizedQuery) return true;
      return `${sentence.text} ${sentence.focus} ${sentence.sectionTitle}`
        .toLocaleLowerCase('en-US')
        .includes(normalizedQuery);
    });
  }, [deferredQuery, now, progressBySentence, reviewFilter, sectionId, selectedCollection]);

  const openCollection = (collection: RealLifeCollection) => {
    setSelectedCollectionId(collection.id);
    setSectionId('all');
    setReviewFilter('all');
    setQuery('');
  };

  const closeCollection = () => {
    setSelectedCollectionId(null);
    setSectionId('all');
    setReviewFilter('all');
    setQuery('');
  };

  const openSentence = (ordered: RealLifeSentence[], index: number) => {
    onOpenSentence(buildRealLifeStudyItems(ordered, progressItems, Date.now()), index);
  };

  const startStudy = () => {
    if (!selectedCollection) return;
    const actionable = selectedCollection.sentences.filter(sentence => {
      const item = progressBySentence.get(sentence.id);
      return (item?.srs?.totalReviews ?? 0) === 0 || (item?.srs?.nextReview ?? 0) <= now;
    });
    openSentence(actionable.length > 0 ? actionable : selectedCollection.sentences, 0);
  };

  if (!selectedCollection) {
    return (
      <div className="h-full min-h-0 overflow-y-auto bg-slate-50" onScroll={onScroll}>
        <div className="mx-auto w-full max-w-5xl px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-10">
          <header className="mb-6 sm:mb-9">
            <div className="flex items-center gap-2 text-indigo-600">
              <Compass size={20} />
              <span className="text-xs font-bold uppercase tracking-[0.18em]">Real Life</span>
            </div>
            <h1 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight text-slate-950 sm:text-5xl">
              Practice the English people actually use.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-500 sm:text-base">
              Choose a situation, hear every line in natural American English, and open any sentence for its complete learning analysis.
            </p>
          </header>

          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-amber-500" />
              <h2 className="text-sm font-bold text-slate-800">Collections</h2>
            </div>
            <span className="text-xs font-medium text-slate-400">{REAL_LIFE_COLLECTIONS.length} available</span>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:gap-5">
            {REAL_LIFE_COLLECTIONS.map(collection => (
              <CollectionTile
                key={collection.id}
                collection={collection}
                progress={collectionProgress.get(collection.id)!}
                onOpen={() => openCollection(collection)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const style = collectionStyle[selectedCollection.accent];
  const CollectionIcon = style.icon;
  const selectedProgress = collectionProgress.get(selectedCollection.id)!;

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <header className="z-10 shrink-0 border-b border-slate-200 bg-white/95 px-3 pb-3 pt-3 backdrop-blur-sm sm:px-4">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={closeCollection}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
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
                <h1 className="truncate text-base font-bold text-slate-900 sm:text-lg">{selectedCollection.title}</h1>
                <span className="shrink-0 text-xs font-medium text-slate-400">{selectedCollection.sentences.length}</span>
              </div>
              <p className="truncate text-[11px] text-slate-500 sm:text-xs">{selectedCollection.description}</p>
            </div>
            <span className={`hidden rounded-full px-2.5 py-1 text-xs font-bold sm:inline-flex ${style.soft}`}>
              {selectedCollection.level}
            </span>
            <button
              type="button"
              onClick={startStudy}
              className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl bg-slate-900 px-3 text-xs font-bold text-white transition-colors hover:bg-slate-700"
              title={`Study ${selectedCollection.title}`}
            >
              <Play size={14} fill="currentColor" /> Study
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-slate-50 px-3 py-2 text-center">
            <div><p className="text-sm font-bold text-slate-800">{selectedProgress.masteryScore}%</p><p className="text-[10px] text-slate-400">mastery</p></div>
            <div><p className="text-sm font-bold text-slate-800">{selectedProgress.reviewed}/{selectedProgress.total}</p><p className="text-[10px] text-slate-400">reviewed</p></div>
            <div><p className="text-sm font-bold text-orange-600">{selectedProgress.toReview}</p><p className="text-[10px] text-slate-400">to review</p></div>
          </div>

          <div className="relative mt-3">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }}
              placeholder={`Search ${selectedCollection.title.toLocaleLowerCase('en-US')}…`}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-9 text-sm text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white"
              autoComplete="off"
              autoCapitalize="off"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                title="Clear search"
              >
                <X size={15} />
              </button>
            )}
          </div>

          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
            {([
              ['all', 'All', selectedProgress.total],
              ['unreviewed', 'Unreviewed', selectedProgress.unreviewed],
              ['due', 'Due', selectedProgress.due],
              ['memorized', 'Memorized', selectedProgress.memorized],
            ] as [SentenceReviewFilter, string, number][]).map(([key, label, count]) => (
              <button
                type="button"
                key={key}
                onClick={() => setReviewFilter(key)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${reviewFilter === key ? style.active : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                {label} <span className={reviewFilter === key ? 'text-white/70' : 'text-slate-400'}>{count}</span>
              </button>
            ))}
          </div>

          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
            <button
              type="button"
              onClick={() => setSectionId('all')}
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${sectionId === 'all' ? style.active : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              All {selectedCollection.sentences.length}
            </button>
            {selectedCollection.sections.map(section => (
              <button
                type="button"
                key={section.id}
                onClick={() => setSectionId(section.id)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${sectionId === section.id ? style.active : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                title={section.description}
              >
                {section.title} <span className={sectionId === section.id ? 'text-white/70' : 'text-slate-400'}>{section.sentences.length}</span>
              </button>
            ))}
          </div>

          {selectedCollection.sourceNote && (
            <details className="mt-2 rounded-xl border border-amber-100 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-950">
              <summary className="cursor-pointer font-bold">Methodology &amp; public sources</summary>
              <p className="mt-1.5 leading-relaxed text-amber-900/80">{selectedCollection.sourceNote}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {selectedCollection.sourceLinks?.map(link => (
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
          <p className="text-sm font-medium text-slate-500">No conversations match “{deferredQuery.trim()}”</p>
          <button type="button" onClick={() => setQuery('')} className="mt-2 text-xs font-semibold text-indigo-600 hover:text-indigo-700">
            Clear search
          </button>
        </div>
      ) : (
        <Virtuoso
          className="min-h-0 flex-1"
          data={filtered}
          overscan={400}
          onScroll={onScroll as any}
          components={{ Footer: () => <div className="h-[calc(6rem+env(safe-area-inset-bottom))]" /> }}
          itemContent={(index, sentence) => {
            const saved = isSentenceSaved(sentence.text);
            const progressItem = progressBySentence.get(sentence.id);
            const reviews = progressItem?.srs?.totalReviews ?? 0;
            const actionable = reviews === 0 || (progressItem?.srs?.nextReview ?? 0) <= now;
            const mastery = progressItem?.srs ? SRSAlgorithm.getMasteryLevel(progressItem.srs) : null;
            return (
              <div className="mx-auto w-full max-w-5xl px-3 pt-2 sm:px-4">
                <article
                  role="button"
                  tabIndex={0}
                  onClick={() => openSentence(filtered, index)}
                  onKeyDown={event => { if (event.key === 'Enter') openSentence(filtered, index); }}
                  className="group cursor-pointer rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm transition-all hover:border-indigo-200 hover:shadow-md sm:p-4"
                  title="Open the full sentence lesson"
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 flex h-7 min-w-7 shrink-0 items-center justify-center rounded-lg px-1 text-[10px] font-bold tabular-nums ${style.soft}`}>
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
                        {reviews > 0 ? (
                          <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                            <CheckCircle2 size={11} /> {Math.round(mastery?.percentage ?? 0)}%
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">Unreviewed</span>
                        )}
                        <div className="ml-auto flex shrink-0 items-center gap-2">
                          {actionable && (
                            <button
                              type="button"
                              onClick={event => {
                                event.stopPropagation();
                                void onUpdateSRS(
                                  realLifeProgressItemId(sentence.id),
                                  'good',
                                  { seedItem: createRealLifeProgressItem(sentence) },
                                );
                              }}
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
          }}
        />
      )}
    </div>
  );
};
