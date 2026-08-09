import React, { Fragment, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Clock3,
  ExternalLink,
  Feather,
  Play,
  Quote,
  Sparkles,
} from 'lucide-react';
import type { StoredItem } from '../types';
import { ESSAYS, type Essay, type EssaySentence } from '../services/essayCatalog';
import {
  buildEssayStudyItems,
  getEssayProgress,
  indexEssayProgress,
  type EssayProgress,
} from '../services/essayProgress';

interface EssaysViewProps {
  onOpenSentence: (ordered: StoredItem[], index: number) => void;
  progressItems: StoredItem[];
  onScroll: (event: React.UIEvent<HTMLElement>) => void;
}

const essayStyle = {
  indigo: {
    tile: 'from-indigo-950 via-indigo-800 to-blue-600',
    soft: 'bg-indigo-50 text-indigo-700',
    reader: 'selection:bg-indigo-200',
  },
  amber: {
    tile: 'from-stone-950 via-amber-900 to-orange-600',
    soft: 'bg-amber-50 text-amber-800',
    reader: 'selection:bg-amber-200',
  },
  violet: {
    tile: 'from-slate-950 via-violet-900 to-fuchsia-700',
    soft: 'bg-violet-50 text-violet-700',
    reader: 'selection:bg-violet-200',
  },
  rose: {
    tile: 'from-rose-950 via-rose-800 to-orange-500',
    soft: 'bg-rose-50 text-rose-700',
    reader: 'selection:bg-rose-200',
  },
  emerald: {
    tile: 'from-emerald-950 via-emerald-800 to-teal-500',
    soft: 'bg-emerald-50 text-emerald-700',
    reader: 'selection:bg-emerald-200',
  },
} as const;

const EssayTile: React.FC<{
  essay: Essay;
  progress: EssayProgress;
  onOpen: () => void;
}> = ({ essay, progress, onOpen }) => {
  const style = essayStyle[essay.accent];
  const reviewedPercent = progress.total === 0 ? 0 : Math.round((progress.reviewed / progress.total) * 100);
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
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/20 bg-white/10 backdrop-blur-sm">
            <Feather size={21} />
          </span>
          <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider backdrop-blur-sm">
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

export const EssaysView: React.FC<EssaysViewProps> = ({ onOpenSentence, progressItems, onScroll }) => {
  const [selectedEssayId, setSelectedEssayId] = useState<string | null>(null);
  const selectedEssay = ESSAYS.find(essay => essay.id === selectedEssayId) ?? null;
  const now = useMemo(() => Date.now(), [progressItems]);
  const progressIndex = useMemo(() => indexEssayProgress(progressItems), [progressItems]);
  const progressByEssay = useMemo(
    () => new Map(ESSAYS.map(essay => [essay.id, getEssayProgress(essay, progressItems, now)])),
    [now, progressItems],
  );

  const openSentence = (essay: Essay, sentence: EssaySentence) => {
    const index = essay.sentences.findIndex(candidate => candidate.id === sentence.id);
    onOpenSentence(buildEssayStudyItems(essay.sentences, progressItems, Date.now()), Math.max(0, index));
  };

  const startReview = (essay: Essay) => {
    const actionable = essay.sentences.filter(sentence => {
      const item = progressIndex.get(sentence.id);
      return (item?.srs?.totalReviews ?? 0) === 0 || (item?.srs?.nextReview ?? 0) <= now;
    });
    const sentences = actionable.length > 0 ? actionable : essay.sentences;
    onOpenSentence(buildEssayStudyItems(sentences, progressItems, Date.now()), 0);
  };

  if (!selectedEssay) {
    return (
      <div className="h-full min-h-0 overflow-y-auto bg-slate-50" onScroll={onScroll}>
        <div className="mx-auto w-full max-w-5xl px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-10">
          <header className="mb-7 sm:mb-10">
            <div className="flex items-center gap-2 text-indigo-600">
              <BookOpenText size={20} />
              <span className="text-xs font-bold uppercase tracking-[0.18em]">Classic Essays</span>
            </div>
            <h1 className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-slate-950 sm:text-5xl">
              Read the whole argument, one sentence at a time.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-500 sm:text-base">
              Five public-domain American classics, selected for lasting ideas and memorable prose. Tap any sentence to hear it, unpack it, and memorize it in that essay’s own review queue.
            </p>
          </header>

          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-amber-500" />
              <h2 className="text-sm font-bold text-slate-800">The collection</h2>
            </div>
            <span className="text-xs font-medium text-slate-400">{ESSAYS.length} complete essays</span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
            {ESSAYS.map(essay => (
              <EssayTile
                key={essay.id}
                essay={essay}
                progress={progressByEssay.get(essay.id)!}
                onOpen={() => setSelectedEssayId(essay.id)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const style = essayStyle[selectedEssay.accent];
  const progress = progressByEssay.get(selectedEssay.id)!;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f8f7f3]">
      <header className="z-10 shrink-0 border-b border-stone-200 bg-[#fdfcf8]/95 px-3 py-3 backdrop-blur-sm sm:px-5">
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <button
            type="button"
            onClick={() => setSelectedEssayId(null)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-stone-100 hover:text-slate-900"
            title="Back to essays"
            aria-label="Back to essays"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold text-slate-950 sm:text-lg">{selectedEssay.title}</h1>
            <p className="truncate text-[11px] text-slate-500 sm:text-xs">{selectedEssay.author} · {selectedEssay.publication}</p>
          </div>
          <button
            type="button"
            onClick={() => startReview(selectedEssay)}
            className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl bg-slate-950 px-3 text-xs font-bold text-white transition-colors hover:bg-slate-700 sm:px-4"
            title={`Review ${selectedEssay.title}`}
          >
            <Play size={14} fill="currentColor" /> Review
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
        <article className={`mx-auto max-w-4xl px-5 pb-[calc(8rem+env(safe-area-inset-bottom))] pt-8 sm:px-10 sm:pt-14 ${style.reader}`}>
          <header className="mx-auto max-w-3xl border-b border-stone-300 pb-8 text-center sm:pb-10">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-stone-500">{selectedEssay.eyebrow}</p>
            <h2 className="mt-4 font-serif text-4xl font-semibold leading-tight tracking-tight text-stone-950 sm:text-6xl">{selectedEssay.title}</h2>
            <p className="mt-4 font-serif text-lg italic text-stone-600">{selectedEssay.author}</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs text-stone-500">
              <span className={`rounded-full px-2.5 py-1 font-semibold ${style.soft}`}>{selectedEssay.level}</span>
              <span className="flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-1"><Clock3 size={12} /> {selectedEssay.readingMinutes} min</span>
              <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1">{selectedEssay.wordCount.toLocaleString()} words</span>
            </div>
            <p className="mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-stone-600">{selectedEssay.description}</p>
          </header>

          <section className="mx-auto mt-7 grid max-w-3xl grid-cols-3 gap-2 rounded-2xl border border-stone-200 bg-white/80 p-3 text-center shadow-sm">
            <div><p className="text-lg font-bold text-stone-900">{progress.masteryScore}%</p><p className="text-[10px] uppercase tracking-wider text-stone-400">mastery</p></div>
            <div><p className="text-lg font-bold text-stone-900">{progress.reviewed}/{progress.total}</p><p className="text-[10px] uppercase tracking-wider text-stone-400">reviewed</p></div>
            <div><p className="text-lg font-bold text-orange-600">{progress.toReview}</p><p className="text-[10px] uppercase tracking-wider text-stone-400">to review</p></div>
          </section>

          <aside className="mx-auto mt-5 max-w-3xl rounded-2xl border border-stone-200 bg-stone-100/70 px-4 py-3 text-xs leading-relaxed text-stone-600">
            <span className="font-bold text-stone-800">Reading note:</span> {selectedEssay.modernityNote} Every body sentence is clickable; the original historical wording is preserved.
          </aside>

          <div className="mx-auto mt-10 max-w-3xl font-serif text-[1.08rem] leading-[1.9] text-stone-800 sm:mt-14 sm:text-xl sm:leading-[2]">
            {selectedEssay.paragraphs.map((paragraph, paragraphIndex) => {
              if (paragraph.kind === 'epigraph') {
                return (
                  <blockquote key={`epigraph-${paragraphIndex}`} className="mx-auto my-8 max-w-2xl whitespace-pre-line border-l-2 border-stone-300 pl-5 text-base italic leading-relaxed text-stone-500 sm:text-lg">
                    {paragraph.text}
                  </blockquote>
                );
              }
              return (
                <p key={paragraph.id} className="mb-6 indent-7 sm:mb-7 sm:indent-10">
                  {paragraph.sentences.map((sentence, sentenceIndex) => {
                    const item = progressIndex.get(sentence.id);
                    const reviews = item?.srs?.totalReviews ?? 0;
                    const due = reviews > 0 && (item?.srs?.nextReview ?? 0) <= now;
                    const stateClass = due
                      ? 'decoration-orange-400 decoration-2 underline underline-offset-4'
                      : reviews > 0
                        ? 'decoration-emerald-300 underline underline-offset-4'
                        : '';
                    return (
                      <Fragment key={sentence.id}>
                        <button
                          type="button"
                          onClick={() => openSentence(selectedEssay, sentence)}
                          className={`inline cursor-pointer rounded px-0.5 text-left font-inherit text-inherit transition-colors hover:bg-indigo-100 hover:text-indigo-950 focus-visible:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${stateClass}`}
                          title={`Open sentence ${sentence.position} of ${selectedEssay.sentenceCount}`}
                          aria-label={`Open sentence ${sentence.position}: ${sentence.text}`}
                        >
                          {sentence.text}
                        </button>
                        {sentenceIndex < paragraph.sentences.length - 1 ? ' ' : ''}
                      </Fragment>
                    );
                  })}
                </p>
              );
            })}
          </div>

          <footer className="mx-auto mt-12 max-w-3xl border-t border-stone-300 pt-6 text-xs leading-relaxed text-stone-500">
            <p>{selectedEssay.publicDomainNote}</p>
            <a
              href={selectedEssay.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 font-semibold text-indigo-600 hover:text-indigo-800"
            >
              {selectedEssay.sourceLabel} <ExternalLink size={12} />
            </a>
          </footer>
        </article>
      </div>
    </div>
  );
};
