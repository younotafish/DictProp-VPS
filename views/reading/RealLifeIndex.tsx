import React, { useMemo } from 'react';
import { ArrowRight, Compass, Sparkles } from 'lucide-react';
import { REAL_LIFE_COLLECTIONS, type RealLifeCollection } from '../../services/realLifeCatalog';
import { summarizeCatalogProgress, type CatalogProgressIndex } from '../../services/catalogProgress';
import { dueNewLine } from '../../services/catalogQueue';
import type { ReviewSummary } from '../../services/sentenceReviewState';
import { collectionStyle } from './realLifeStyle';

const CollectionTile: React.FC<{
  collection: RealLifeCollection;
  progress: ReviewSummary;
  onOpen: () => void;
}> = ({ collection, progress, onOpen }) => {
  const style = collectionStyle[collection.accent];
  const Icon = style.icon;
  const reviewLine = dueNewLine(progress);
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
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/20 bg-white/15 sm:h-12 sm:w-12">
            <Icon size={23} />
          </span>
          <span className="rounded-full border border-white/20 bg-white/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider sm:text-xs">
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
          {collection.sections.length > 3 && (
            <span className="rounded-full bg-black/10 px-2 py-1 text-[9px] font-semibold text-white/90 sm:text-[11px]">
              +{collection.sections.length - 3} themes
            </span>
          )}
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
              {/* A pill, because orange text can't be read on the amber, rose and sky tiles. */}
              {reviewLine.due && <span className="rounded-full bg-orange-500/90 px-1.5 py-0.5 text-white">{reviewLine.due}</span>}
              {reviewLine.rest}
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

interface RealLifeIndexProps {
  progressIndex: CatalogProgressIndex;
  now: number;
  onOpenCollection: (collectionId: string) => void;
  onScroll: (event: React.UIEvent<HTMLElement>) => void;
}

/** The Real Life landing page: a tile for each collection, with its progress. */
export function RealLifeIndex({ progressIndex, now, onOpenCollection, onScroll }: RealLifeIndexProps) {
  const collectionProgress = useMemo(
    () => new Map(REAL_LIFE_COLLECTIONS.map(collection => [
      collection.id,
      summarizeCatalogProgress(collection.sentences, progressIndex, now),
    ])),
    [now, progressIndex],
  );

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
              onOpen={() => onOpenCollection(collection.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
