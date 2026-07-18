import React from 'react';
import { ArrowLeft, BookOpenText, Globe2, History, Languages, Search } from 'lucide-react';
import { SentenceData } from '../types';
import { OfflineImage } from './OfflineImage';
import { stripSentenceMarkers } from './HighlightedSentence';

interface SentenceAnalysisViewProps {
  sentence: SentenceData;
  position: number;
  total: number;
  imageSrc?: string;
  imageVersion: number;
  onBack: () => void;
  onSearch: (term: string) => void;
  onMissingImage?: (itemId: string) => Promise<string | null>;
  onTouchStart: React.TouchEventHandler<HTMLDivElement>;
  onTouchEnd: React.TouchEventHandler<HTMLDivElement>;
}

const STATUS_LABEL = {
  american: 'Distinctly American',
  shared: 'Shared English',
  not_american: 'Not American',
} as const;

const STATUS_CLASS = {
  american: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  shared: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  not_american: 'bg-amber-50 text-amber-700 border-amber-200',
} as const;

export const SentenceAnalysisView: React.FC<SentenceAnalysisViewProps> = ({
  sentence,
  position,
  total,
  imageSrc,
  imageVersion,
  onBack,
  onSearch,
  onMissingImage,
  onTouchStart,
  onTouchEnd,
}) => {
  const analysis = sentence.analysis;
  const plainSentence = stripSentenceMarkers(sentence.text || '').trim();

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-white animate-in slide-in-from-right duration-200"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
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
          <div className="aspect-video max-h-[52vh] min-h-48 w-full overflow-hidden bg-slate-100">
            <OfflineImage
              key={`${sentence.id}:${imageVersion}`}
              src={imageSrc}
              itemId={sentence.id}
              alt={`Visual depiction of: ${plainSentence}`}
              onMissing={onMissingImage}
              className="h-full w-full object-cover"
              fallbackClassName="h-full w-full"
            />
          </div>

          <main className="px-4 pb-[calc(3rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:px-8">
            <p className="text-base leading-relaxed text-slate-500 sm:text-lg">{plainSentence}</p>

            {!analysis ? (
              <div className="mt-10 border-y border-slate-200 py-10 text-center">
                <BookOpenText className="mx-auto mb-3 text-slate-300" size={28} />
                <p className="text-sm font-semibold text-slate-500">Analysis pending</p>
              </div>
            ) : (
              <>
                <section className="mt-7 border-t border-slate-200 pt-6">
                  <div className="mb-2 flex items-center gap-2 text-slate-500">
                    <Languages size={17} className="text-rose-500" />
                    <h2 className="text-xs font-bold uppercase text-slate-500">Chinese translation</h2>
                  </div>
                  <p lang="zh-CN" className="text-xl font-semibold leading-relaxed text-slate-900 sm:text-2xl">
                    {analysis.translation}
                  </p>
                </section>

                <section className="mt-7 border-t border-slate-200 pt-6">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Globe2 size={17} className="text-indigo-500" />
                    <h2 className="text-xs font-bold uppercase text-slate-500">American English</h2>
                    <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${STATUS_CLASS[analysis.americanEnglish.status]}`}>
                      {STATUS_LABEL[analysis.americanEnglish.status]}
                    </span>
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
