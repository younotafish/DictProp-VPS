import { ExternalLink, Search as SearchIcon, X } from 'lucide-react';
import type { SearchResult, SentenceData, VocabCard } from '../../types';
import { buildChatGPTUrl } from '../../components/VocabCard';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { PronunciationBlock } from '../../components/PronunciationBlock';
import { OfflineImage } from '../../components/OfflineImage';
import { GrammarNotes } from './GrammarNotes';
import { PhraseVocabCard } from './PhraseVocabCard';
import { PLATFORM } from './platform';

interface PhraseBodyProps {
  phrase: SearchResult;
  onLazyLoadImage?: (itemId: string, imageVersion?: string) => Promise<string | null>;
  /** Offered while the phrase keeps more than one word. */
  onRemoveVocabFromPhrase?: (phraseId: string, vocabId: string) => void;
  /** Saves a key-vocabulary word, or un-saves it when it's saved already. */
  onSaveVocab: (vocab: VocabCard) => void;
  isVocabSaved: (vocab: VocabCard) => boolean;
  onSearch: (text: string) => void;
  onCompare?: (words: string[]) => void;
  onSaveSentence?: (text: string, word: string, sense?: string, prepared?: SentenceData) => void;
  onOpenExampleSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
}

/**
 * A phrase card: its picture, translation, pronunciation, links out and grammar notes, then a card for each of its
 * key-vocabulary words.
 */
export function PhraseBody({
  phrase, onLazyLoadImage, onRemoveVocabFromPhrase, onSaveVocab, isVocabSaved, onSearch, onCompare, onSaveSentence,
  onOpenExampleSentence, isSentenceSaved,
}: PhraseBodyProps) {
  return (
    <div className="space-y-6 max-w-3xl md:max-w-5xl lg:max-w-6xl xl:max-w-[1400px] 2xl:max-w-[1600px] mx-auto">
      <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="md:flex">
          {/* With a picture, a fixed height on phones so the text below doesn't move when it arrives. */}
          <div className={`bg-slate-100 relative overflow-hidden flex items-center justify-center group md:w-2/5 md:shrink-0 ${phrase.imageUrl ? 'h-48 md:h-auto' : ''}`}>
            {phrase.imageUrl ? (
              <OfflineImage src={phrase.imageUrl} itemId={phrase.id} alt="Visual context" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" onMissing={onLazyLoadImage} />
            ) : (
              <div className="flex flex-col items-center text-slate-400 py-8">
                <SearchIcon className="mb-2 opacity-30" size={32}/>
                <span className="text-xs uppercase font-bold tracking-wider opacity-60">{phrase.visualKeyword}</span>
              </div>
            )}
          </div>

        <div className="p-6 sm:p-8 md:flex-1 md:min-w-0">
          <div className="mb-6">
            <h2 className="text-2xl xl:text-3xl font-bold text-slate-900 leading-tight mb-2">{phrase.translation}</h2>
            <p className="text-lg xl:text-xl text-slate-600 mb-3 leading-relaxed">{phrase.query}</p>
            <PronunciationBlock
              text={phrase.query}
              ipa={phrase.pronunciation}
              className="text-base bg-slate-100 px-2 py-1 rounded-lg w-full"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href={`https://www.playphrase.me/#/search?q=${encodeURIComponent(phrase.query)}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.stopPropagation();
                  try { window.dispatchEvent(new Event('dictprop:before-external-nav')); } catch (_) {}
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 hover:bg-purple-100 hover:border-purple-300 transition-all active:scale-95 shadow-sm"
                title="Hear in movie & TV clips on PlayPhrase.me"
              >
                <ExternalLink size={12} />
                PlayPhrase
              </a>
              <a
                href={buildChatGPTUrl(phrase.query)}
                {...(!PLATFORM.isMobile && { target: '_blank', rel: 'noopener noreferrer' })}
                onClick={(e) => {
                  e.stopPropagation();
                  try { window.dispatchEvent(new Event('dictprop:before-external-nav')); } catch (_) {}
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 hover:bg-teal-100 hover:border-teal-300 transition-all active:scale-95 shadow-sm"
                title="Ask ChatGPT (translator mode)"
              >
                <ExternalLink size={12} />
                ChatGPT
              </a>
            </div>
          </div>

          <div className="prose prose-indigo prose-sm sm:prose-base xl:text-lg max-w-none text-slate-600">
            <GrammarNotes markdown={phrase.grammar} />
          </div>
        </div>
      </div>{/* close md:flex */}
      </div>

      {(phrase.vocabs || []).length > 0 && (
        <div>
          <div className="px-2 mb-4 flex items-center gap-2">
            <SearchIcon size={16} className="text-indigo-500" />
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Key Vocabulary</h3>
          </div>
          <div className="grid gap-4">
            {(phrase.vocabs || []).map((vocab) => (
              <ErrorBoundary key={vocab.id} variant="inline" fallbackMessage="This card couldn't be displayed.">
                <div className="relative group/vocab">
                  {onRemoveVocabFromPhrase && phrase.vocabs.length > 1 && (
                    <button
                      onClick={() => onRemoveVocabFromPhrase(phrase.id, vocab.id)}
                      className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full bg-slate-200 text-slate-500 hover:bg-rose-500 hover:text-white flex items-center justify-center opacity-0 group-hover/vocab:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-all duration-150 shadow-sm"
                      title="Remove this vocab"
                      aria-label={`Remove ${vocab.word} from this phrase`}
                    >
                      <X size={14} />
                    </button>
                  )}
                  <PhraseVocabCard
                    vocab={vocab}
                    onSaveVocab={onSaveVocab}
                    isSaved={isVocabSaved(vocab)}
                    onSearch={onSearch}
                    scrollable={false}
                    showSave={true}
                    className="!h-auto !overflow-visible border-slate-200 shadow-sm hover:shadow-md transition-shadow"
                    onCompare={onCompare}
                    onSaveSentence={onSaveSentence}
                    onOpenExampleSentence={onOpenExampleSentence}
                    isSentenceSaved={isSentenceSaved}
                    onLazyLoadImage={onLazyLoadImage}
                  />
                </div>
              </ErrorBoundary>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
