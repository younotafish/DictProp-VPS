import React, { Fragment, useCallback, useMemo } from 'react';
import { ArrowLeft, ArrowRight, Clock3, ExternalLink, Play } from 'lucide-react';
import type { StoredItem } from '../../types';
import { useEscapeLayer } from '../../components/escapeStack';
import type { Essay, EssayBodyParagraph, EssaySentence } from '../../services/essayCatalog';
import { buildEssayStudyItems } from '../../services/essayProgress';
import { summarizeCatalogProgress, type CatalogProgressIndex } from '../../services/catalogProgress';
import { buildCatalogQueue, studyButtonLabel } from '../../services/catalogQueue';
import { sentenceReviewState, type SentenceReviewState } from '../../services/sentenceReviewState';
import { useLatest } from '../../hooks/useStableValue';
import { essayStyle } from './essayStyle';

// A paragraph's review states as one letter per sentence, so it re-renders only when one of its own changes.
const STATE_LETTER: Record<SentenceReviewState, string> = { unreviewed: 'u', due: 'd', memorized: 'm' };
const STATE_UNDERLINE: Record<string, string> = {
  u: '',
  d: 'decoration-orange-400 decoration-2 underline underline-offset-4',
  m: 'decoration-emerald-300 underline underline-offset-4',
};

interface EssayParagraphProps {
  paragraph: EssayBodyParagraph;
  /** Each sentence's review state, one letter apiece: u(nreviewed), d(ue) or m(emorized). */
  states: string;
  sentenceCount: number;
  onOpenSentence: (sentence: EssaySentence) => void;
}

/** A body paragraph, each sentence a button underlined by its review state. */
const EssayParagraph = React.memo(function EssayParagraph({
  paragraph,
  states,
  sentenceCount,
  onOpenSentence,
}: EssayParagraphProps) {
  return (
    <p className="mb-6 indent-7 sm:mb-7 sm:indent-10">
      {paragraph.sentences.map((sentence, sentenceIndex) => {
        const stateClass = STATE_UNDERLINE[states[sentenceIndex]];
        return (
          <Fragment key={sentence.id}>
            <button
              type="button"
              onClick={() => onOpenSentence(sentence)}
              className={`inline cursor-pointer rounded px-0.5 text-left text-inherit transition-colors hover:bg-indigo-100 hover:text-indigo-950 focus-visible:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${stateClass}`}
              title={`Open sentence ${sentence.position} of ${sentenceCount}`}
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
});

interface EssayReaderProps {
  essay: Essay;
  progressIndex: CatalogProgressIndex;
  now: number;
  onBack: () => void;
  onOpenSentence: (ordered: StoredItem[], index: number) => void;
  onScroll: (event: React.UIEvent<HTMLElement>) => void;
  /** The next reading of the same publication (nextReading), linked at the end. */
  nextEssay?: Essay | null;
  onOpenEssay?: (essayId: string) => void;
}

/**
 * An essay on one page, each body sentence a button that opens its lesson, and Study for its due reviews and then its
 * new sentences.
 */
export function EssayReader({
  essay,
  progressIndex,
  now,
  onBack,
  onOpenSentence,
  onScroll,
  nextEssay,
  onOpenEssay,
}: EssayReaderProps) {
  const progress = useMemo(
    () => summarizeCatalogProgress(essay.sentences, progressIndex, now),
    [essay, now, progressIndex],
  );
  const studyQueue = useMemo(() => buildCatalogQueue(essay.sentences, progressIndex, now), [essay, now, progressIndex]);

  // Read when tapped, so the paragraphs' callback stays the same while progress changes.
  const latest = useLatest({ essay, progressIndex, onOpenSentence });
  const openSentence = useCallback((sentence: EssaySentence) => {
    const { essay, progressIndex, onOpenSentence } = latest.current;
    const index = essay.sentences.findIndex(candidate => candidate.id === sentence.id);
    onOpenSentence(buildEssayStudyItems(essay.sentences, progressIndex, Date.now()), Math.max(0, index));
  }, [latest]);

  const startStudy = () => {
    onOpenSentence(buildEssayStudyItems(studyQueue.sentences, progressIndex, Date.now()), 0);
  };

  // Esc goes back to the essays, unless a layer above (a lesson, a dialog, the search sheet) takes it first.
  useEscapeLayer(onBack, 0);

  const style = essayStyle[essay.accent];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f8f7f3]">
      <header className="z-10 shrink-0 border-b border-stone-200 bg-[#fdfcf8] px-3 py-3 sm:px-5">
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-stone-100 hover:text-slate-900"
            title="Back to essays"
            aria-label="Back to essays"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold text-slate-950 sm:text-lg">{essay.title}</h1>
            <p className="truncate text-[11px] text-slate-500 sm:text-xs">{essay.author} · {essay.publication}</p>
          </div>
          {/* Wide enough for 'Practice' and 'Study 999', so a changing count never moves the header. */}
          <button
            type="button"
            onClick={startStudy}
            disabled={studyQueue.sentences.length === 0}
            className="flex min-h-10 min-w-[6.5rem] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-slate-950 px-3 text-xs font-bold text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:px-4"
            title={`Study ${essay.title}`}
          >
            <Play size={14} fill="currentColor" /> <span className="tabular-nums">{studyButtonLabel(studyQueue)}</span>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
        <article className={`mx-auto max-w-4xl px-5 pb-[calc(8rem+env(safe-area-inset-bottom))] pt-8 sm:px-10 sm:pt-14 ${style.reader}`}>
          <header className="mx-auto max-w-3xl border-b border-stone-300 pb-8 text-center sm:pb-10">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-stone-500">{essay.eyebrow}</p>
            <h2 className="mt-4 font-serif text-4xl font-semibold leading-tight tracking-tight text-stone-950 sm:text-6xl">{essay.title}</h2>
            <p className="mt-4 font-serif text-lg italic text-stone-600">{essay.author}</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs text-stone-500">
              <span className={`rounded-full px-2.5 py-1 font-semibold ${style.soft}`}>{essay.level}</span>
              <span className="flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-1"><Clock3 size={12} /> {essay.readingMinutes} min</span>
              <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1">{essay.wordCount.toLocaleString()} words</span>
            </div>
            <p className="mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-stone-600">{essay.description}</p>
          </header>

          <section className="mx-auto mt-7 grid max-w-3xl grid-cols-3 gap-2 rounded-2xl border border-stone-200 bg-white/80 p-3 text-center shadow-sm">
            <div><p className="text-lg font-bold text-stone-900">{progress.masteryScore}%</p><p className="text-[10px] uppercase tracking-wider text-stone-400">mastery</p></div>
            <div><p className="text-lg font-bold text-stone-900">{progress.reviewed}/{progress.total}</p><p className="text-[10px] uppercase tracking-wider text-stone-400">reviewed</p></div>
            <div><p className="text-lg font-bold text-orange-600">{progress.due}</p><p className="text-[10px] uppercase tracking-wider text-stone-400">due · {progress.unreviewed} new</p></div>
          </section>

          <aside className="mx-auto mt-5 max-w-3xl rounded-2xl border border-stone-200 bg-stone-100/70 px-4 py-3 text-xs leading-relaxed text-stone-600">
            <span className="font-bold text-stone-800">Reading note:</span> {essay.modernityNote} Every body sentence is clickable; {essay.collection === 'classic' ? 'the original historical wording is preserved.' : 'its review history remains isolated inside this essay.'}
          </aside>

          <div className="mx-auto mt-10 max-w-3xl font-serif text-[1.08rem] leading-[1.9] text-stone-800 sm:mt-14 sm:text-xl sm:leading-[2]">
            {essay.paragraphs.map((paragraph, paragraphIndex) => {
              if (paragraph.kind === 'epigraph') {
                return (
                  <blockquote key={`epigraph-${paragraphIndex}`} className="mx-auto my-8 max-w-2xl whitespace-pre-line border-l-2 border-stone-300 pl-5 text-base italic leading-relaxed text-stone-500 sm:text-lg">
                    {paragraph.text}
                  </blockquote>
                );
              }
              return (
                <EssayParagraph
                  key={paragraph.id}
                  paragraph={paragraph}
                  states={paragraph.sentences
                    .map(sentence => STATE_LETTER[sentenceReviewState(progressIndex.get(sentence.id)?.srs, now)])
                    .join('')}
                  sentenceCount={essay.sentenceCount}
                  onOpenSentence={openSentence}
                />
              );
            })}
          </div>

          {nextEssay && onOpenEssay && (
            <div className="mx-auto mt-12 max-w-3xl">
              <button
                type="button"
                onClick={() => onOpenEssay(nextEssay.id)}
                className="group flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white px-4 py-3 text-left text-sm font-semibold text-stone-800 shadow-sm transition-colors hover:border-indigo-200 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 sm:text-base"
              >
                <span className="min-w-0 truncate">Next: {nextEssay.title}</span>
                <ArrowRight size={18} className="shrink-0 text-stone-400 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-500" />
              </button>
            </div>
          )}

          <footer className="mx-auto mt-12 max-w-3xl border-t border-stone-300 pt-6 text-xs leading-relaxed text-stone-500">
            <p>{essay.rightsNote ?? essay.publicDomainNote}</p>
            <a
              href={essay.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 font-semibold text-indigo-600 hover:text-indigo-800"
            >
              {essay.sourceLabel} <ExternalLink size={12} />
            </a>
          </footer>
        </article>
      </div>
    </div>
  );
}
