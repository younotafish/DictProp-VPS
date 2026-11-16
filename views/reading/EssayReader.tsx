import React, { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Clock3, ExternalLink, Play } from 'lucide-react';
import type { SentenceData, StoredItem } from '../../types';
import { useEscapeLayer } from '../../components/escapeStack';
import type { Essay, EssayBodyParagraph, EssaySentence } from '../../services/essayCatalog';
import { buildEssayStudyItems } from '../../services/essayProgress';
import { beginLesson, subscribeLessonEnd } from '../../services/lessonTrail';
import { summarizeCatalogProgress, type CatalogProgressIndex } from '../../services/catalogProgress';
import { buildCatalogQueue, studyButtonLabel } from '../../services/catalogQueue';
import { sentenceReviewState, type SentenceReviewState } from '../../services/sentenceReviewState';
import {
  lastSentenceReached,
  readingPosition,
  returnTarget,
  scrollTopToShow,
  sentenceAtReadingLine,
  type ReadingPosition,
  type SentenceBox,
} from '../../services/readingPosition';
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
  /** A sentence of this paragraph to tint for a moment, the one a lesson just came back to. */
  highlightId?: string;
}

/** A body paragraph, each sentence a button underlined by its review state. */
const EssayParagraph = React.memo(function EssayParagraph({
  paragraph,
  states,
  sentenceCount,
  onOpenSentence,
  highlightId,
}: EssayParagraphProps) {
  return (
    <p className="mb-6 indent-7 sm:mb-7 sm:indent-10">
      {paragraph.sentences.map((sentence, sentenceIndex) => {
        const stateClass = STATE_UNDERLINE[states[sentenceIndex]] + (sentence.id === highlightId ? ' bg-indigo-100' : '');
        return (
          <Fragment key={sentence.id}>
            <button
              type="button"
              data-sentence-id={sentence.id}
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
  /** Where this essay was left. Read as it opens: an essay not read to its end opens at that sentence. */
  initialPosition?: ReadingPosition;
  /** Keeps the place the reader leaves the essay at. Without it, no place is kept. */
  onSavePosition?: (entry: ReadingPosition) => void;
}

/** A body sentence where it was measured in the reader's scrolled page. */
interface MeasuredSentence extends SentenceBox {
  id: string;
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
  initialPosition,
  onSavePosition,
}: EssayReaderProps) {
  const progress = useMemo(
    () => summarizeCatalogProgress(essay.sentences, progressIndex, now),
    [essay, now, progressIndex],
  );
  const studyQueue = useMemo(() => buildCatalogQueue(essay.sentences, progressIndex, now), [essay, now, progressIndex]);

  // Read when a sentence is tapped and when the essay opens or is left, so the paragraphs' callback stays the same while
  // progress changes.
  const latest = useLatest({ essay, progressIndex, onOpenSentence, initialPosition, onSavePosition });
  // Where the last reading lesson opened, for when the sentence it ended on has gone from the essay.
  const lessonOpenedAtRef = useRef(1);
  const openSentence = useCallback((sentence: EssaySentence) => {
    const { essay, progressIndex, onOpenSentence } = latest.current;
    const index = essay.sentences.findIndex(candidate => candidate.id === sentence.id);
    lessonOpenedAtRef.current = sentence.position;
    beginLesson({ kind: 'essay', collectionId: essay.id, mode: 'read' });
    onOpenSentence(buildEssayStudyItems(essay.sentences, progressIndex, Date.now()), Math.max(0, index));
  }, [latest]);

  const startStudy = () => {
    beginLesson({ kind: 'essay', collectionId: essay.id, mode: 'study' });
    onOpenSentence(buildEssayStudyItems(studyQueue.sentences, progressIndex, Date.now()), 0);
  };

  // Where the body sentences are in the scrolled page, measured once it is laid out and again after a resize, and where
  // it is scrolled, so that leaving needn't measure anything (an unmounting page is already gone).
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sentencesRef = useRef<MeasuredSentence[]>([]);
  const viewRef = useRef({ scrollTop: 0, height: 0 });
  // The scrollTop when the essay opened or its place was last kept: leaving from there keeps nothing new.
  const keptAtRef = useRef(0);
  const openedRef = useRef(false);
  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const contentTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
    sentencesRef.current = [...scroller.querySelectorAll<HTMLElement>('[data-sentence-id]')].map(button => {
      const box = button.getBoundingClientRect();
      return { id: button.dataset.sentenceId ?? '', top: box.top - contentTop, bottom: box.bottom - contentTop };
    });
    viewRef.current.height = scroller.clientHeight;
  }, []);
  // An essay not read to its end opens at the sentence it was left at, put on the reading line before the first paint;
  // one read to its end opens at its title.
  useLayoutEffect(() => {
    measure();
    const scroller = scrollerRef.current;
    if (scroller && !openedRef.current) {
      openedRef.current = true;
      const { essay, initialPosition } = latest.current;
      if (initialPosition && !initialPosition.f) {
        const target = returnTarget({ id: initialPosition.s, position: initialPosition.p }, essay.sentences);
        const box = sentencesRef.current.find(sentence => sentence.id === target?.id);
        const top = box ? scrollTopToShow(box, 0, viewRef.current.height) : null;
        if (top !== null) scroller.scrollTop = top;
      }
      viewRef.current.scrollTop = keptAtRef.current = scroller.scrollTop;
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [essay, latest, measure]);

  // Leaving keeps the sentence on the reading line as the essay's place, if the page moved since it opened or since its
  // place was last kept, and the reader has reached the text.
  const keepPlace = useCallback(() => {
    const { essay, onSavePosition } = latest.current;
    const { scrollTop, height } = viewRef.current;
    if (!onSavePosition || Math.abs(scrollTop - keptAtRef.current) < 1) return;
    const sentences = sentencesRef.current;
    const index = sentenceAtReadingLine(sentences, scrollTop, height);
    const sentence = index < 0 ? undefined : essay.sentences.find(candidate => candidate.id === sentences[index].id);
    if (!sentence) return;
    keptAtRef.current = scrollTop;
    onSavePosition(readingPosition(essay, sentence, lastSentenceReached(sentences, scrollTop, height), Date.now()));
  }, [latest]);
  // The app put away (closed, or another app in front) or the tab left, or the essay closed some other way.
  useEffect(() => {
    const keepWhenHidden = () => { if (document.visibilityState === 'hidden') keepPlace(); };
    document.addEventListener('visibilitychange', keepWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', keepWhenHidden);
      keepPlace();
    };
  }, [keepPlace]);
  // Back, Esc and Next keep the place first, so the Essays page or the next reading opens with it already kept.
  const back = () => {
    keepPlace();
    onBack();
  };
  const handleScroll = (event: React.UIEvent<HTMLElement>) => {
    viewRef.current.scrollTop = event.currentTarget.scrollTop;
    onScroll(event);
  };

  // A reading lesson opened here (a tapped sentence, not a Study run) brings the page back, when it closes, to the last
  // sentence it showed, which becomes the essay's place: on the reading line if it's out of view, tinted for a moment,
  // and focused where there's a fine pointer (a laptop), so Enter opens it again.
  const [returnedTo, setReturnedTo] = useState<{ id: string } | null>(null);
  useEffect(() => subscribeLessonEnd(({ origin, lastItem }) => {
    const { essay, onSavePosition } = latest.current;
    if (origin.collectionId !== essay.id || origin.mode !== 'read' || !lastItem) return;
    const lastId = (lastItem.data as SentenceData).catalogSentenceId ?? '';
    const target = returnTarget({ id: lastId, position: lessonOpenedAtRef.current }, essay.sentences);
    if (!target) return;
    onSavePosition?.(readingPosition(essay, target, target === essay.sentences[essay.sentences.length - 1], Date.now()));
    setReturnedTo({ id: target.id });
  }), [latest]);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const button = returnedTo && [...(scroller?.querySelectorAll<HTMLElement>('[data-sentence-id]') ?? [])]
      .find(candidate => candidate.dataset.sentenceId === returnedTo.id);
    if (!scroller || !button) return;
    const contentTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const box = button.getBoundingClientRect();
    const top = scrollTopToShow(
      { top: box.top - contentTop, bottom: box.bottom - contentTop }, scroller.scrollTop, scroller.clientHeight,
    );
    if (top !== null) scroller.scrollTop = top;
    viewRef.current.scrollTop = keptAtRef.current = scroller.scrollTop;
    if (window.matchMedia?.('(pointer: fine)').matches) button.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setReturnedTo(null), 1_500);
    return () => window.clearTimeout(timer);
  }, [returnedTo]);

  // Esc goes back to the essays, unless a layer above (a lesson, a dialog, the search sheet) takes it first.
  useEscapeLayer(back, 0);

  const style = essayStyle[essay.accent];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f8f7f3]">
      <header className="z-10 shrink-0 border-b border-stone-200 bg-[#fdfcf8] px-3 py-3 sm:px-5">
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <button
            type="button"
            onClick={back}
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

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto" onScroll={handleScroll}>
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
                  highlightId={paragraph.sentences.some(sentence => sentence.id === returnedTo?.id) ? returnedTo?.id : undefined}
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
                onClick={() => {
                  keepPlace();
                  onOpenEssay(nextEssay.id);
                }}
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
