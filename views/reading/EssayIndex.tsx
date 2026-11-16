import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { ArrowRight, BookOpenText, Feather, Quote, Sparkles } from 'lucide-react';
import type { Essay } from '../../services/essayCatalog';
import { summarizeCatalogProgress, type CatalogProgressIndex } from '../../services/catalogProgress';
import { dueNewLine } from '../../services/catalogQueue';
import type { ReviewSummary } from '../../services/sentenceReviewState';
import { continueCandidate, returnTarget, type ContinueReading, type ReadingPosition } from '../../services/readingPosition';
import { essayStyle } from './essayStyle';
import { groupModernEssays } from './essayGroups';
import type { PrivateCatalogStatus } from './useEssayCatalog';

const NO_POSITIONS: readonly ReadingPosition[] = [];

const EssayTile: React.FC<{
  essay: Essay;
  progress: ReviewSummary;
  onOpen: () => void;
}> = ({ essay, progress, onOpen }) => {
  const style = essayStyle[essay.accent];
  const reviewedPercent = progress.total === 0 ? 0 : Math.round((progress.reviewed / progress.total) * 100);
  const reviewLine = dueNewLine(progress);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative min-h-[20rem] overflow-hidden rounded-[1.75rem] bg-gradient-to-br ${style.tile} p-5 text-left text-white shadow-lg shadow-slate-300/60 transition hover:-translate-y-0.5 hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:min-h-[23rem] sm:p-7`}
    >
      <div className="absolute -right-12 -top-12 h-44 w-44 rounded-full border border-white/10 bg-white/5" />
      <div className="absolute -bottom-24 -left-16 h-64 w-64 rounded-full border border-white/10 bg-black/10" />
      <Quote className="absolute right-5 top-16 text-white/10" size={86} strokeWidth={1.25} />
      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/20 bg-white/10">
            <Feather size={21} />
          </span>
          <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider">
            {essay.level}
          </span>
        </div>

        <div className="mt-8 sm:mt-10">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/65 sm:text-xs">{essay.eyebrow}</p>
          <h2 className="mt-2 text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">{essay.title}</h2>
          <p className="mt-2 text-xs font-medium text-white/70 sm:text-sm">{essay.author} · {essay.year}</p>
          <p className="mt-4 line-clamp-3 text-xs leading-relaxed text-white/80 sm:text-sm">{essay.description}</p>
        </div>

        <div className="mt-auto pt-7">
          <div className="mb-4">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold text-white/70 sm:text-xs">
              <span>{progress.reviewed} reviewed</span>
              <span>{progress.masteryScore}% mastery</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-black/20">
              <div className="h-full rounded-full bg-white/90 transition-all" style={{ width: `${reviewedPercent}%` }} />
            </div>
          </div>
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-2xl font-bold tabular-nums sm:text-3xl">{essay.sentenceCount}</p>
              <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/65 sm:text-xs">
                sentences · {essay.readingMinutes} min
              </p>
              <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/65 sm:text-xs">
                {/* A pill, as on the Real Life tiles: orange text can't be read on every gradient. */}
                {reviewLine.due && <span className="rounded-full bg-orange-500/90 px-1.5 py-0.5 text-white">{reviewLine.due}</span>}
                {reviewLine.rest}
              </p>
            </div>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-slate-900 transition-transform group-hover:translate-x-1">
              <ArrowRight size={18} />
            </span>
          </div>
        </div>
      </div>
    </button>
  );
};

/**
 * The essay left most recently before its end, offered above the tiles. A private essay shows its stored title, and
 * can't be opened, until the private catalog has loaded.
 */
const ContinueCard: React.FC<{ reading: ContinueReading<Essay>; onOpen: (essayId: string) => void }> = ({ reading, onOpen }) => {
  const { entry, essay } = reading;
  // The sentence it opens at: the one left at, or where the catalog put its place since.
  const position = essay ? returnTarget({ id: entry.s, position: entry.p }, essay.sentences)?.position ?? entry.p : entry.p;
  return (
    <button
      type="button"
      onClick={essay ? () => onOpen(essay.id) : undefined}
      disabled={!essay}
      className="mb-7 flex w-full items-center gap-3 rounded-2xl border border-indigo-100 bg-white p-4 text-left shadow-sm transition hover:border-indigo-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60 disabled:hover:border-indigo-100 disabled:hover:shadow-sm sm:mb-9 sm:p-5"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
        <BookOpenText size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-bold uppercase tracking-[0.16em] text-indigo-500 sm:text-xs">Continue reading</span>
        <span className="mt-0.5 block truncate text-sm font-semibold text-slate-900 sm:text-base">{essay?.title ?? entry.t}</span>
        <span className="block text-xs tabular-nums text-slate-500">
          Sentence {position} of {essay ? essay.sentences.length : entry.n}
        </span>
      </span>
      <ArrowRight size={18} className="shrink-0 text-slate-400" />
    </button>
  );
};

interface EssayIndexProps {
  essays: readonly Essay[];
  catalogStatus: PrivateCatalogStatus;
  onRetryCatalog: () => void;
  progressIndex: CatalogProgressIndex;
  now: number;
  onOpenEssay: (essayId: string) => void;
  onScroll: (event: React.UIEvent<HTMLElement>) => void;
  /** Where the page is scrolled, kept while it's away (an essay open over it) and put back when it mounts again. */
  scrollMemory?: { current: number };
  /** Where the essays were left, for the Continue card. */
  readingPositions?: readonly ReadingPosition[];
}

/** The Essays landing page: the historical classics, then the private modern collection grouped by publication. */
export function EssayIndex({
  essays,
  catalogStatus,
  onRetryCatalog,
  progressIndex,
  now,
  onOpenEssay,
  onScroll,
  scrollMemory,
  readingPositions = NO_POSITIONS,
}: EssayIndexProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollMemory && scrollerRef.current) scrollerRef.current.scrollTop = scrollMemory.current;
  }, [scrollMemory]);
  const handleScroll = (event: React.UIEvent<HTMLElement>) => {
    if (scrollMemory) scrollMemory.current = event.currentTarget.scrollTop;
    onScroll(event);
  };
  const progressByEssay = useMemo(
    () => new Map(essays.map(essay => [essay.id, summarizeCatalogProgress(essay.sentences, progressIndex, now)])),
    [essays, now, progressIndex],
  );
  const classicEssays = useMemo(() => essays.filter(essay => essay.collection === 'classic'), [essays]);
  const modernEssays = useMemo(() => essays.filter(essay => essay.collection === 'modern'), [essays]);
  const modernGroups = useMemo(() => groupModernEssays(modernEssays), [modernEssays]);
  const continueReading = useMemo(
    () => continueCandidate(readingPositions, essays, catalogStatus === 'ready'),
    [readingPositions, essays, catalogStatus],
  );

  return (
    <div ref={scrollerRef} className="h-full min-h-0 overflow-y-auto bg-slate-50" onScroll={handleScroll}>
      <div className="mx-auto w-full max-w-5xl px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-10">
        <header className="mb-7 sm:mb-10">
          <div className="flex items-center gap-2 text-indigo-600">
            <BookOpenText size={20} />
            <span className="text-xs font-bold uppercase tracking-[0.18em]">American Essays</span>
          </div>
          <h1 className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-slate-950 sm:text-5xl">
            Read the whole argument, one sentence at a time.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-500 sm:text-base">
            Historical American classics and a private modern collection, each preserved as a complete reading experience. Tap any sentence to hear it, unpack it, and memorize it in that essay’s own review queue.
          </p>
        </header>

        {continueReading && <ContinueCard reading={continueReading} onOpen={onOpenEssay} />}

        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-amber-500" />
            <h2 className="text-sm font-bold text-slate-800">The collection</h2>
          </div>
          <span className="text-xs font-medium text-slate-400">{essays.length} complete essays</span>
        </div>

        <div className="mb-3 mt-5">
          <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Historical classics</h3>
          <p className="mt-1 text-xs text-slate-400">Public-domain texts that preserve their original period voice.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
          {classicEssays.map(essay => (
            <EssayTile
              key={essay.id}
              essay={essay}
              progress={progressByEssay.get(essay.id)!}
              onOpen={() => onOpenEssay(essay.id)}
            />
          ))}
        </div>

        <div className="mb-3 mt-9">
          <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Modern American voices</h3>
          <p className="mt-1 text-xs text-slate-400">Owner-private study texts selected for natural, influential modern prose.</p>
        </div>
        {modernEssays.length > 0 ? (
          <div className="space-y-8">
            {modernGroups.map(group => (
              <section key={group.title}>
                {modernGroups.length > 1 && (
                  <div className="mb-3 flex items-baseline justify-between gap-3">
                    <h4 className="text-sm font-bold text-slate-700">{group.title}</h4>
                    <span className="shrink-0 text-xs font-medium text-slate-400">
                      {group.essays.length} {group.essays.length === 1 ? 'reading' : 'readings'}
                    </span>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
                  {group.essays.map(essay => (
                    <EssayTile
                      key={essay.id}
                      essay={essay}
                      progress={progressByEssay.get(essay.id)!}
                      onOpen={() => onOpenEssay(essay.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-7 text-sm text-slate-500">
            {catalogStatus === 'loading'
              ? 'Loading the private modern collection…'
              : catalogStatus === 'error'
                ? (
                  <>
                    The private modern collection is temporarily unavailable; the historical collection remains fully usable.
                    <button
                      type="button"
                      onClick={onRetryCatalog}
                      className="mt-3 block rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200"
                    >
                      Try again
                    </button>
                  </>
                )
                : 'No private modern essays have been imported yet.'}
          </div>
        )}
      </div>
    </div>
  );
}
