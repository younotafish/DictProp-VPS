import React from 'react';
import { ArrowLeft, AudioLines, BadgeCheck, BookOpenText, Braces, Globe2, History, Languages, Search, TriangleAlert, type LucideIcon } from 'lucide-react';
import { SentenceData } from '../types';
import { stripSentenceMarkers } from './HighlightedSentence';

interface SentenceAnalysisViewProps {
  sentence: SentenceData;
  position: number;
  total: number;
  onBack: () => void;
  onSearch: (term: string) => void;
  onTouchStart: React.TouchEventHandler<HTMLDivElement>;
  onTouchEnd: React.TouchEventHandler<HTMLDivElement>;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
}

const STATUS_PRESENTATION: Record<'american' | 'shared' | 'not_american', {
  label: string;
  className: string;
  icon: LucideIcon;
}> = {
  american: { label: 'Distinctly American', className: 'border-emerald-200 bg-emerald-50 text-emerald-700', icon: BadgeCheck },
  shared: { label: 'Natural shared English', className: 'border-sky-200 bg-sky-50 text-sky-700', icon: Globe2 },
  not_american: { label: 'Not natural American English', className: 'border-amber-200 bg-amber-50 text-amber-700', icon: TriangleAlert },
};

export const SentenceAnalysisView: React.FC<SentenceAnalysisViewProps> = ({
  sentence,
  position,
  total,
  onBack,
  onSearch,
  onTouchStart,
  onTouchEnd,
  onClick,
  onDoubleClick,
}) => {
  const analysis = sentence.analysis;
  const plainSentence = stripSentenceMarkers(sentence.text || '').trim();
  const americanEnglishPresentation = analysis ? STATUS_PRESENTATION[analysis.americanEnglish.status] : null;
  const AmericanEnglishIcon = americanEnglishPresentation?.icon;

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-white animate-in slide-in-from-right duration-200"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <header className="shrink-0 border-b border-slate-200 bg-white/95 px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex h-9 items-center gap-1 px-1 text-sm font-semibold text-slate-600 transition-colors hover:text-indigo-600"
            title="Back to sentence"
          >
            <ArrowLeft size={18} /> Sentence
          </button>
          <div className="min-w-0 text-center">
            <p className="truncate text-sm font-semibold text-slate-800">Sentence analysis</p>
            <p className="text-[11px] text-slate-400">{position} / {total}</p>
          </div>
          <div className="w-[76px]" aria-hidden="true" />
        </div>
      </header>

      <div
        data-sentence-analysis
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        style={{ touchAction: 'pan-y pinch-zoom' }}
      >
        <div className="mx-auto w-full max-w-5xl">
          <main className="px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:px-8">
            <h1 className="max-w-4xl text-2xl font-semibold leading-tight text-slate-950 sm:text-3xl lg:text-4xl">
              {plainSentence}
            </h1>

            {!analysis ? (
              <div className="mt-10 border-y border-slate-200 py-10 text-center">
                <BookOpenText className="mx-auto mb-3 text-slate-300" size={28} />
                <p className="text-sm font-semibold text-slate-500">Analysis pending</p>
              </div>
            ) : (
              <>
                {analysis.naturalSpeechIpa && (
                  <section className="mt-5 border-t border-slate-200 pt-5">
                    <div className="mb-2 flex items-center gap-2 text-slate-500">
                      <AudioLines size={17} className="text-cyan-600" />
                      <h2 className="text-xs font-bold uppercase text-slate-500">Natural speech IPA</h2>
                    </div>
                    <p className="max-w-4xl break-words font-mono text-base leading-relaxed text-slate-800 sm:text-lg">
                      {analysis.naturalSpeechIpa}
                    </p>
                  </section>
                )}

                <section className="mt-7 border-t border-slate-200 pt-6">
                  <div className="mb-2 flex items-center gap-2 text-slate-500">
                    <Languages size={17} className="text-rose-500" />
                    <h2 className="text-xs font-bold uppercase text-slate-500">Chinese translation</h2>
                  </div>
                  <p lang="zh-CN" className="max-w-4xl text-base font-normal leading-relaxed text-slate-700 sm:text-lg">
                    {analysis.translation}
                  </p>
                </section>

                <section className="mt-7 border-t border-slate-200 pt-6">
                  <div className="mb-3 flex items-center gap-2 text-slate-500">
                    <Braces size={17} className="text-violet-600" />
                    <h2 className="text-xs font-bold uppercase text-slate-500">Grammar analysis</h2>
                  </div>
                  {analysis.grammar ? (
                    <div className="max-w-4xl">
                      <p className="border-l-2 border-violet-200 pl-3 text-base leading-relaxed text-slate-800">
                        {analysis.grammar.structure}
                      </p>
                      {analysis.grammar.points.length > 0 && (
                        <div className="mt-5 divide-y divide-slate-100 border-y border-slate-100">
                          {analysis.grammar.points.map((point, index) => (
                            <div key={`${point.label}:${point.excerpt}:${index}`} className="py-4 first:pt-0 last:pb-0">
                              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <h3 className="text-sm font-bold text-slate-800">{point.label}</h3>
                                <span className="rounded bg-violet-50 px-2 py-0.5 text-sm text-violet-700">{point.excerpt}</span>
                              </div>
                              <p className="mt-2 text-sm leading-relaxed text-slate-600 sm:text-base">
                                {point.explanation}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">Grammar analysis pending.</p>
                  )}
                </section>

                <section className="mt-7 border-t border-slate-200 pt-6">
                  <div className="mb-3 flex items-center gap-3">
                    {americanEnglishPresentation && AmericanEnglishIcon && (
                      <span
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border ${americanEnglishPresentation.className}`}
                        role="img"
                        aria-label={americanEnglishPresentation.label}
                        title={americanEnglishPresentation.label}
                      >
                        <AmericanEnglishIcon size={22} strokeWidth={2.3} />
                      </span>
                    )}
                    <h2 className="text-xs font-bold uppercase text-slate-500">American English</h2>
                  </div>
                  <p className="max-w-3xl text-base leading-relaxed text-slate-700">
                    {analysis.americanEnglish.explanation}
                  </p>
                </section>

                <section className="mt-8 border-t border-slate-200 pt-6">
                  <div className="mb-4 flex items-center gap-2">
                    <BookOpenText size={17} className="text-emerald-600" />
                    <h2 className="text-xs font-bold uppercase text-slate-500">Uncommon words and phrases</h2>
                    <span className="text-xs text-slate-400">{analysis.terms.length}</span>
                  </div>

                  {analysis.terms.length === 0 ? (
                    <p className="border-y border-slate-100 py-6 text-sm text-slate-500">No uncommon expressions detected.</p>
                  ) : (
                    <div className="grid gap-4">
                      {analysis.terms.map((term, index) => (
                        <article key={`${term.term}:${index}`} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <h3 className="text-xl font-bold text-slate-900">{term.term}</h3>
                                <span className="font-mono text-sm text-indigo-600">{term.ipa}</span>
                              </div>
                              <p lang="zh-CN" className="mt-1 text-base font-semibold text-rose-600">{term.chinese}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => onSearch(term.term)}
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
                              title={`Search ${term.term}`}
                              aria-label={`Search ${term.term}`}
                            >
                              <Search size={17} />
                            </button>
                          </div>

                          <div className="mt-4">
                            <h4 className="text-[11px] font-bold uppercase text-slate-400">Original meaning</h4>
                            <p className="mt-1 leading-relaxed text-slate-700">{term.originalMeaning}</p>
                          </div>

                          <div className="mt-4 grid gap-4 sm:grid-cols-2">
                            <div>
                              <h4 className="text-[11px] font-bold uppercase text-slate-400">Synonyms</h4>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {term.synonyms.map(value => (
                                  <span key={value} className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">{value}</span>
                                ))}
                              </div>
                            </div>
                            <div>
                              <h4 className="text-[11px] font-bold uppercase text-slate-400">Antonyms</h4>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {term.antonyms.length > 0 ? term.antonyms.map(value => (
                                  <span key={value} className="rounded-md bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700">{value}</span>
                                )) : <span className="text-sm text-slate-400">None in this context</span>}
                              </div>
                            </div>
                          </div>

                          <div className="mt-4 border-t border-slate-100 pt-4">
                            <h4 className="text-[11px] font-bold uppercase text-slate-400">Usage examples</h4>
                            <div className="mt-2 space-y-2">
                              {term.examples.map((example, exampleIndex) => (
                                <p key={exampleIndex} className="border-l-2 border-indigo-200 pl-3 text-sm leading-relaxed text-slate-600">
                                  {example}
                                </p>
                              ))}
                            </div>
                          </div>

                          <div className="mt-4 flex gap-2 border-t border-slate-100 pt-4">
                            <History size={15} className="mt-0.5 shrink-0 text-amber-500" />
                            <p className="text-sm leading-relaxed text-slate-600">{term.historicalEvolution}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};
