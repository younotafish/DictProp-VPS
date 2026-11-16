import { memo, useState } from 'react';
import { VocabCard as VocabType, WordFamilyEntry, type UsageAudit } from '../types';
import { Archive, BadgeCheck, BookOpen, BriefcaseBusiness, Check, Flame, History, Lightbulb, MapPin, Maximize2, Network, RefreshCw, Scale, Shapes, Sparkles, X, BookmarkPlus, BookmarkCheck, type LucideIcon } from 'lucide-react';
import { PronunciationBlock } from './PronunciationBlock';
import { ExternalLinkChip, chipClassName } from './ExternalLinkChip';
import { OfflineImage } from './OfflineImage';
import { HighlightedSentence } from './HighlightedSentence';
import { SentenceSpeakerButton } from './SentenceSpeakerButton';
import { MAX_COMPARE_WORDS } from '../services/queryMode';
import { wordCardLinks, youglishUrl } from '../services/externalLinks';
import { PLATFORM } from '../services/platform';

// DetailView's phrase links still import the ChatGPT link from here.
export { chatGptUrl as buildChatGPTUrl } from '../services/externalLinks';

// YouGlish sits in the pronunciation row, styled to match it rather than the other links.
const YOUGLISH_CLASS =
  'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium text-slate-500 bg-slate-50 border border-slate-200 hover:bg-slate-100 hover:border-slate-300 transition-all active:scale-95 shadow-sm cursor-pointer';

interface Props {
  data: VocabType;
  onSave?: () => void;
  isSaved?: boolean;
  /**
   * Added after the card's own classes, but Tailwind's stylesheet order, not the attribute's, settles a
   * conflict, and it orders utilities by name: a class setting something the card already sets wins or
   * loses alphabetically (bg-transparent loses to bg-white, border-indigo-200 to border-slate-100).
   */
  className?: string;
  showSave?: boolean;
  onSearch?: (term: string) => void;
  /** @deprecated Ignored: the card never scrolls or clips itself. Still passed by PhraseBody, WordDetailView and
   *  SearchResultsCarousel until they drop it. */
  scrollable?: boolean;
  showRefresh?: boolean;
  /** Real refresh: re-run the AI for this word (bypassing the saved-card reuse). Falls back to onSearch. */
  onRefresh?: (term: string) => void;
  onCompare?: (words: string[]) => void;
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  onOpenExampleSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
  onLazyLoadImage?: (itemId: string, imageVersion?: string) => Promise<string | null>;
}

const usagePresentation: Record<UsageAudit['status'], { label: string; className: string; icon: LucideIcon }> = {
  modern_american: { label: 'Modern American', className: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: Flame },
  current_general: { label: 'Current general English', className: 'bg-sky-50 text-sky-700 border-sky-200', icon: BadgeCheck },
  british_only: { label: 'British only', className: 'bg-amber-50 text-amber-800 border-amber-200', icon: MapPin },
  rare_or_dated: { label: 'Rare or dated', className: 'bg-rose-50 text-rose-700 border-rose-200', icon: Archive },
  narrow_specialized: { label: 'Specialized current usage', className: 'bg-slate-100 text-slate-700 border-slate-300', icon: BriefcaseBusiness },
};

// The AI's lists are normally string arrays, but a malformed card can hold a string, junk entries or
// nothing; whatever it holds becomes the strings it contains.
const ensureArray = (items: unknown): string[] => {
  if (Array.isArray(items)) return items.filter((x): x is string => typeof x === 'string');
  if (typeof items === 'string') return [items];
  return [];
};

function UsageBadge({ audit, expanded, onToggle }: { audit: UsageAudit; expanded: boolean; onToggle: () => void }) {
  const presentation = usagePresentation[audit.status];
  const UsageIcon = presentation.icon;
  return (
    <div className="mt-1.5 max-w-xl">
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onToggle(); }}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-md border shadow-sm transition-transform hover:scale-105 ${presentation.className}`}
        title={`${presentation.label}: ${audit.reason}`}
        aria-label={presentation.label}
        aria-expanded={expanded}
      >
        <UsageIcon size={19} strokeWidth={2.4} />
      </button>
      {expanded && (
        <p className="mt-1.5 text-xs leading-5 text-slate-500">
          <span className="font-semibold text-slate-700">{presentation.label}.</span>{' '}
          {audit.reason}
        </p>
      )}
    </div>
  );
}

// Synonyms compare in indigo, confusables in amber.
const COMPARE_TONES = {
  indigo: {
    start: 'inline-flex items-center gap-1 text-[10px] font-bold text-indigo-400 hover:text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-1.5 py-0.5 rounded-full transition-colors uppercase tracking-wider',
    go: 'text-white bg-indigo-500 hover:bg-indigo-600',
  },
  amber: {
    start: 'inline-flex items-center gap-1 text-[10px] font-bold text-amber-400 hover:text-amber-600 bg-amber-50 hover:bg-amber-100 px-1.5 py-0.5 rounded-full transition-colors uppercase tracking-wider',
    go: 'text-white bg-amber-500 hover:bg-amber-600',
  },
};

interface CompareControlsProps {
  tone: keyof typeof COMPARE_TONES;
  /** The Compare button's tooltip. */
  title: string;
  /** Whether Compare is offered while the section isn't picking. */
  canStart: boolean;
  /** Whether this section is picking words to compare. */
  picking: boolean;
  /** How many words are picked, besides the card's own. */
  picked: number;
  onStart: () => void;
  onGo: () => void;
  onCancel: () => void;
}

/** A section's Compare button, or, while it picks words, its Go (n) and Cancel buttons. */
function CompareControls({ tone, title, canStart, picking, picked, onStart, onGo, onCancel }: CompareControlsProps) {
  const classes = COMPARE_TONES[tone];
  return (
    <>
      {canStart && !picking && (
        <button
          onClick={(e) => { e.stopPropagation(); onStart(); }}
          className={classes.start}
          title={title}
        >
          <Scale size={10} /> Compare
        </button>
      )}
      {picking && (
        <span className="inline-flex items-center gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); onGo(); }}
            disabled={picked < 1}
            className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full transition-colors uppercase tracking-wider ${
              picked >= 1
                ? classes.go
                : 'text-slate-400 bg-slate-100 cursor-not-allowed'
            }`}
            title="Run comparison"
          >
            <Scale size={10} /> Go ({picked + 1})
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            className="text-slate-400 hover:text-slate-600 p-0.5 rounded-full hover:bg-slate-100 transition-colors"
            title="Cancel"
          >
            <X size={12} />
          </button>
        </span>
      )}
    </>
  );
}

interface ExampleRowProps {
  text: string;
  /** Its position in the card's list, for the buttons' labels. */
  index: number;
  word: string;
  sense?: string;
  onSearch?: (term: string) => void;
  onOpenExampleSentence?: (text: string, word: string, sense?: string) => void;
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
}

/** One example sentence with its open, listen and save buttons. */
function ExampleRow({ text, index, word, sense, onSearch, onOpenExampleSentence, onSaveSentence, isSentenceSaved }: ExampleRowProps) {
  return (
    <li className="border-l-2 border-indigo-200 pl-3 text-sm leading-relaxed text-slate-700 xl:text-base">
      <HighlightedSentence text={text} itemWord={word || ''} onSearchWord={onSearch} />
      <div className="mt-2 flex items-center justify-end gap-2 border-t border-slate-200/80 pt-2">
        {onOpenExampleSentence && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenExampleSentence(text, word, sense); }}
            className="grid h-11 w-11 touch-manipulation place-items-center rounded-md border border-indigo-200 bg-white text-indigo-600 transition-colors hover:bg-indigo-50"
            title="Open sentence review"
            aria-label={`Open example ${index + 1} in sentence review`}
          >
            <Maximize2 size={18} />
          </button>
        )}
        <SentenceSpeakerButton
          text={text}
          iconSize={18}
          className="grid h-11 w-11 touch-manipulation place-items-center rounded-md border border-sky-200 bg-white !p-0 text-sky-600 hover:bg-sky-50"
        />
        {onSaveSentence && (
          <SaveExampleButton
            saved={isSentenceSaved?.(text) ?? false}
            index={index}
            onSave={() => onSaveSentence(text, word, sense)}
          />
        )}
      </div>
    </li>
  );
}

function SaveExampleButton({ saved, index, onSave }: { saved: boolean; index: number; onSave: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (!saved) onSave(); }}
      className={`grid h-11 w-11 touch-manipulation place-items-center rounded-md border bg-white transition-colors ${saved ? 'border-emerald-200 text-emerald-600' : 'border-slate-200 text-slate-500 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700'}`}
      title={saved ? 'Sentence saved' : 'Save sentence for review'}
      aria-label={saved ? `Example ${index + 1} saved` : `Save example ${index + 1} for review`}
      disabled={saved}
    >
      {saved ? <BookmarkCheck size={18} /> : <BookmarkPlus size={18} />}
    </button>
  );
}

// Memoized, so a card re-renders only when its own props change, not when the list around it updates.
export const VocabCardDisplay = memo(function VocabCardDisplay({
  data,
  onSave,
  isSaved = false,
  className = '',
  showSave = true,
  onSearch,
  showRefresh = true,
  onRefresh,
  onCompare,
  onSaveSentence,
  onOpenExampleSentence,
  isSentenceSaved,
  onLazyLoadImage,
}: Props) {

  // Compare-pick mode state
  const [comparePicking, setComparePicking] = useState<'synonyms' | 'confusables' | null>(null);
  const [compareSelected, setCompareSelected] = useState<Set<string>>(new Set());
  const [showUsageReason, setShowUsageReason] = useState(false);

  // Compare picks and the usage note belong to the card they were opened on. When the card changes
  // (navigating in DetailView), they close during the same render, so the next card never shows them,
  // not even for a frame. Only what is open gets reset.
  const [openedOnCardId, setOpenedOnCardId] = useState(data.id);
  if (openedOnCardId !== data.id) {
    setOpenedOnCardId(data.id);
    if (comparePicking !== null) setComparePicking(null);
    if (compareSelected.size > 0) setCompareSelected(new Set());
    if (showUsageReason) setShowUsageReason(false);
  }

  const forms = ensureArray(data.forms);
  const examples = ensureArray(data.examples);
  const synonyms = ensureArray(data.synonyms);
  const antonyms = ensureArray(data.antonyms);
  const confusables = ensureArray(data.confusables);
  // The word family's entries are objects: a malformed one is skipped, not a crash.
  const wordFamily = Array.isArray(data.wordFamily)
    ? data.wordFamily.filter((entry): entry is WordFamilyEntry => typeof entry?.word === 'string' && entry.word.trim() !== '')
    : [];

  const toggleCompareSelection = (word: string) => {
    setCompareSelected(prev => {
      const next = new Set(prev);
      if (next.has(word)) {
        next.delete(word);
      } else {
        // The current word plus the picks: a comparison takes at most MAX_COMPARE_WORDS words.
        if (next.size >= MAX_COMPARE_WORDS - 1) return prev;
        next.add(word);
      }
      return next;
    });
  };

  const startComparePick = (section: 'synonyms' | 'confusables') => {
    setComparePicking(section);
    setCompareSelected(new Set());
  };

  const cancelComparePick = () => {
    setComparePicking(null);
    setCompareSelected(new Set());
  };

  const executeCompare = () => {
    if (onCompare && compareSelected.size >= 1) {
      const words = [data.word, ...Array.from(compareSelected)];
      onCompare(words);
      setComparePicking(null);
      setCompareSelected(new Set());
    }
  };

  const refresh = onRefresh ?? onSearch;

  const renderPills = (items: string[], isPickMode: boolean = false) => items.map((item, idx) => {
    if (isPickMode) {
      const isSelected = compareSelected.has(item);
      const atLimit = !isSelected && compareSelected.size >= MAX_COMPARE_WORDS - 1;
      return (
        <button
          key={`${item}-${idx}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleCompareSelection(item);
          }}
          disabled={atLimit}
          title={atLimit ? `A comparison takes up to ${MAX_COMPARE_WORDS} words` : undefined}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded mr-1 mb-1 transition-colors text-left border ${
            isSelected
              ? 'cursor-pointer bg-indigo-100 text-indigo-700 border-indigo-300'
              : atLimit
                ? 'cursor-not-allowed bg-slate-50 text-slate-300 border-slate-100'
                : 'cursor-pointer bg-slate-50 text-slate-600 border-slate-200 hover:bg-indigo-50 hover:border-indigo-200'
          }`}
        >
          {isSelected && <Check size={12} className="shrink-0" />}
          {item}
        </button>
      );
    }
    return (
      <button 
        key={`${item}-${idx}`}
        onClick={(e) => {
          e.stopPropagation();
          onSearch?.(item);
        }}
        className="inline-block bg-slate-100 text-slate-600 px-2 py-0.5 rounded mr-1 mb-1 hover:bg-indigo-100 hover:text-indigo-700 transition-colors cursor-pointer text-left"
      >
        {item}
      </button>
    );
  });

  return (
    <div className={`bg-white rounded-2xl p-5 pb-8 md:pb-4 shadow-md border border-slate-100 flex flex-col select-text ${className}`}>
      {/* Header — title is selectable/copyable; only the action buttons opt out of selection */}
      <div className="flex justify-between items-start mb-3 shrink-0">
        <div className="select-text min-w-0">
          <h3 className="text-2xl xl:text-3xl font-bold text-slate-800 tracking-tight break-words">{data.word || ''}</h3>
          {/* Sense/Meaning Label */}
          {data.sense && (
            <span className="inline-block mt-1 px-2 py-0.5 bg-violet-100 text-violet-700 text-xs font-medium rounded-full">
              {data.sense}
            </span>
          )}
          {data.usageAudit && (
            <UsageBadge audit={data.usageAudit} expanded={showUsageReason} onToggle={() => setShowUsageReason(current => !current)} />
          )}
          <div className="flex items-center gap-2 mt-1 text-slate-500">
            {data.ipa && (
              <PronunciationBlock
                text={data.word}
                ipa={data.ipa}
                className="text-sm bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
              />
            )}
            {/* A link, not YouGlish's embedded player: the page's CSP blocks its script and frames. */}
            <ExternalLinkChip
              href={youglishUrl(data.word || '')}
              label="YouGlish"
              title="Hear it in real videos on YouGlish"
              opening="new-tab"
              className={YOUGLISH_CLASS}
            />
          </div>
        </div>
        <div className="flex items-center gap-1 select-none">
            {showRefresh && refresh && (
                 <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); refresh(data.word); }}
                    title="Refresh — re-run the AI for this word"
                    aria-label="Refresh this word"
                    className="w-11 h-11 shrink-0 rounded-full bg-white/80 shadow-sm hover:bg-white flex items-center justify-center"
                 >
                    <RefreshCw size={18} className="text-slate-400 hover:text-indigo-600" />
                 </button>
            )}
            {showSave && onSave && (
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onSave(); }}
                className={`w-11 h-11 shrink-0 rounded-full shadow-sm flex items-center justify-center ${isSaved ? "text-indigo-600 bg-indigo-50" : "bg-white/80 hover:bg-white text-slate-700"}`}
                title={isSaved ? "Saved" : "Save to notebook"}
                aria-label={isSaved ? "Saved" : "Save to notebook"}
            >
                <Sparkles size={20} fill={isSaved ? "currentColor" : "none"} />
            </button>
            )}
        </div>
      </div>

      {/* Two-column layout on large screens: image left, content right */}
      <div className={`${data.imageUrl ? 'md:flex md:gap-6' : ''}`}>
        {/* Generated Image */}
        {data.imageUrl && (
          <div className="mb-4 md:mb-0 w-full md:w-2/5 md:shrink-0">
            {/* A fixed height, so the text below doesn't move when the picture arrives. */}
            <div className="rounded-xl overflow-hidden h-48 md:h-64 xl:h-80 bg-slate-50 border border-slate-100 shadow-inner">
              <OfflineImage src={data.imageUrl} itemId={data.id} alt={data.word} className="w-full h-full object-cover" onMissing={onLazyLoadImage} />
            </div>
          </div>
        )}

        <div className="md:flex-1 md:min-w-0">
          {/* Core Meaning */}
          <div className="mb-4 md:mb-2 shrink-0">
        <p className="text-xl xl:text-2xl text-slate-700 font-medium leading-relaxed select-text">{data.chinese}</p>
        <p className="text-slate-500 xl:text-lg mt-1 italic leading-relaxed select-text">{data.definition}</p>
        <div className="flex flex-wrap gap-2 mt-2">
          {wordCardLinks(data.word, PLATFORM).map(link => (
            <ExternalLinkChip
              key={link.label}
              href={link.href}
              label={link.label}
              title={link.title}
              opening={link.opening}
              className={chipClassName(link.tone)}
            />
          ))}
        </div>
      </div>

      {/* Word Forms */}
      {forms.length > 0 && (
        <div className="mb-4 md:mb-2 shrink-0">
          <div className="flex items-center gap-2 text-xs font-bold text-indigo-400 uppercase mb-2">
            <Shapes size={12} /> Word Forms
          </div>
          <div className="flex flex-wrap gap-1.5">
            {forms.map((form, idx) => (
              <button
                key={`${form}-${idx}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSearch?.(form);
                }}
                className="inline-flex items-center bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-lg text-sm font-medium hover:bg-indigo-100 transition-colors cursor-pointer border border-indigo-100"
              >
                {form}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Word Family - Related words of different parts of speech */}
      {wordFamily.length > 0 && (
        <div className="mb-4 md:mb-2 shrink-0">
          <div className="flex items-center gap-2 text-xs font-bold text-purple-400 uppercase mb-2">
            <Network size={12} /> Word Family
          </div>
          <div className="flex flex-wrap gap-1.5">
            {wordFamily.map((entry, idx) => (
              <button
                key={`${entry.word}-${idx}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSearch?.(entry.word);
                }}
                className="inline-flex items-center gap-1.5 bg-purple-50 text-purple-700 px-2.5 py-1 rounded-lg text-sm hover:bg-purple-100 transition-colors cursor-pointer border border-purple-100"
              >
                <span className="font-medium">{entry.word}</span>
                <span className="text-purple-400 text-xs">({entry.pos})</span>
                <span className="text-purple-500 text-xs">{entry.chinese}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4 md:space-y-2">
        {/* Example Sentences */}
        <div className="bg-slate-50 p-3 rounded-xl select-text">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase mb-2">
            <BookOpen size={12} /> Usage
          </div>
          <ul className="space-y-2">
            {examples.map((ex, i) => (
              <ExampleRow
                key={i}
                text={ex}
                index={i}
                word={data.word}
                sense={data.sense}
                onSearch={onSearch}
                onOpenExampleSentence={onOpenExampleSentence}
                onSaveSentence={onSaveSentence}
                isSentenceSaved={isSentenceSaved}
              />
            ))}
          </ul>
        </div>

        {/* Info Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-orange-50 p-3 rounded-xl">
            <div className="flex items-center gap-2 text-xs font-bold text-orange-400 uppercase mb-1">
              <History size={12} /> Origins
            </div>
            <p className="text-xs xl:text-sm text-slate-700">{data.history}</p>
          </div>
          <div className="bg-emerald-50 p-3 rounded-xl">
             <div className="flex items-center gap-2 text-xs font-bold text-emerald-500 uppercase mb-1">
              <Lightbulb size={12} /> Mnemonic
            </div>
            <p className="text-xs xl:text-sm text-slate-700">{data.mnemonic}</p>
          </div>
        </div>

        {/* Synonyms/Antonyms/Confusables */}
        <div className="text-sm">
           {/* Synonyms */}
           <div className="mb-1">
             <div className="flex flex-wrap items-baseline gap-2">
               <span className="text-slate-400 font-semibold text-xs uppercase mr-1">Synonyms</span>
               <CompareControls
                 tone="indigo"
                 title="Compare with synonyms"
                 canStart={!!onCompare && synonyms.length > 0}
                 picking={comparePicking === 'synonyms'}
                 picked={compareSelected.size}
                 onStart={() => startComparePick('synonyms')}
                 onGo={executeCompare}
                 onCancel={cancelComparePick}
               />
               <span className="inline">{renderPills(synonyms, comparePicking === 'synonyms')}</span>
             </div>
           </div>

           {/* Antonyms */}
           <p className="mb-1 flex flex-wrap items-baseline gap-2">
             <span className="text-slate-400 font-semibold text-xs uppercase mr-1">Antonyms</span>
             <span className="inline">{renderPills(antonyms)}</span>
           </p>

           {/* Confusables */}
           {confusables.length > 0 && (
             <div>
               <div className="flex flex-wrap items-baseline gap-2">
                 <span className="text-amber-500 font-semibold text-xs uppercase mr-1">Confusables</span>
                 <CompareControls
                   tone="amber"
                   title="Compare with confusables"
                   canStart={!!onCompare}
                   picking={comparePicking === 'confusables'}
                   picked={compareSelected.size}
                   onStart={() => startComparePick('confusables')}
                   onGo={executeCompare}
                   onCancel={cancelComparePick}
                 />
                 <span className="inline">{renderPills(confusables, comparePicking === 'confusables')}</span>
               </div>
             </div>
           )}
        </div>
        
         {/* The server drops a register too short to say anything, so a card can come without one. */}
         {data.register?.trim() && (
         <div className="text-xs xl:text-sm text-slate-400 pt-2 border-t border-slate-100 select-text">
            <span className="font-semibold">Register:</span> {data.register}
         </div>
         )}
      </div>
        </div>{/* close md:flex-1 */}
      </div>{/* close md:flex container */}
    </div>
  );
});
