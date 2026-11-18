import { Fragment } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { StoredItem } from '../../types';
import type { CardStep } from '../../services/learningLoop/session';
import type { LoopCard, LoopCue, LoopHint, LoopMode, TextPart } from '../../services/learningLoop/cues';
import { GRADUATION_DOTS } from '../../services/learningLoop/standing';
import type { SpeakHandle } from '../../services/neuralTts';
import { OfflineImage } from '../../components/OfflineImage';
import { PronunciationBlock } from '../../components/PronunciationBlock';
import { SentenceSpeakerButton } from '../../components/SentenceSpeakerButton';

const EYEBROW = 'text-xs font-bold uppercase tracking-[0.18em] text-slate-400';

/** A blank where the answer goes. Every blank is the same width, so none gives the answer's length away. */
const Blank = () => <span role="img" aria-label="blank" className="mx-0.5 inline-block w-12 border-b-2 border-slate-400 align-[-0.15em]" />;

/** Text with the answer masked as underscores (studyPrompt's maskAnswer), each run drawn as a blank. */
function Blanked({ text }: { text: string }) {
  const pieces = text.split(/_{3,}/);
  return <>{pieces.map((piece, index) => <Fragment key={index}>{index > 0 && <Blank />}{piece}</Fragment>)}</>;
}

/** A sentence cut around its expression (cues.ts TextPart): blanked on a cue, marked on an answer. */
function Parts({ parts, blank, mark }: { parts: readonly TextPart[]; blank?: boolean; mark?: string }) {
  return (
    <>
      {parts.map((part, index) => (
        !part.target ? <Fragment key={index}>{part.text}</Fragment>
          : blank ? <Blank key={index} />
            : <mark key={index} className={mark}>{part.text}</mark>
      ))}
    </>
  );
}

/** The card's picture, from the device or the server like every picture in the app. */
function Picture({ src, item, onLazyLoadImage }: { src: string; item: StoredItem; onLazyLoadImage: LoopCardFaceProps['onLazyLoadImage'] }) {
  return (
    <div className="mt-5 overflow-hidden rounded-xl">
      <OfflineImage src={src} itemId={item.data.id} alt="" onMissing={onLazyLoadImage} className="max-h-56 w-full object-cover" fallbackClassName="h-40 w-full" />
    </div>
  );
}

function CueBody({ cue, item, onLazyLoadImage }: { cue: LoopCue; item: StoredItem; onLazyLoadImage: LoopCardFaceProps['onLazyLoadImage'] }) {
  if (cue.kind === 'word' && cue.level === 1) {
    return (
      <>
        {cue.chinese && <p className="mt-3 text-3xl font-semibold leading-snug text-slate-900">{cue.chinese}</p>}
        {cue.definition && <p className="mt-3 text-base leading-relaxed text-slate-600"><Blanked text={cue.definition} /></p>}
        {cue.partOfSpeech && <p className="mt-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{cue.partOfSpeech}</span></p>}
        {cue.imageUrl && <Picture src={cue.imageUrl} item={item} onLazyLoadImage={onLazyLoadImage} />}
      </>
    );
  }
  if (cue.kind === 'word') {
    return (
      <>
        <p className="mt-3 text-xl leading-relaxed text-slate-800"><Parts parts={cue.example} blank /></p>
        {cue.chinese && <p className="mt-3 text-lg text-slate-600">{cue.chinese}</p>}
      </>
    );
  }
  return (
    <>
      <p className="mt-3 text-2xl font-semibold leading-snug text-slate-900">{cue.translation}</p>
      {cue.level === 1 && <p className="mt-4 text-lg leading-relaxed text-slate-700"><Parts parts={cue.sentence} blank /></p>}
      {cue.level === 2 && cue.imageUrl && <Picture src={cue.imageUrl} item={item} onLazyLoadImage={onLazyLoadImage} />}
    </>
  );
}

function HintBox({ hint }: { hint: LoopHint }) {
  return (
    <div className="mt-5 rounded-xl bg-indigo-50 px-4 py-3 text-indigo-950">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-400">Hint</p>
      {hint.kind === 'letters'
        ? <p className="mt-1 font-mono text-lg tracking-wider">{hint.text}</p>
        : <p className="mt-1 text-lg leading-relaxed"><Parts parts={hint.parts} blank /></p>}
    </div>
  );
}

/** How far a practice item is toward Can say it: filled dots out of five (standing.ts graduationDots). */
export function GraduationDots({ filled }: { filled: number }) {
  return (
    <div className="mt-5 flex items-center gap-2" role="img" aria-label={`Toward Can say it: ${filled} of ${GRADUATION_DOTS}`}>
      <span className="flex gap-1" aria-hidden="true">
        {Array.from({ length: GRADUATION_DOTS }, (_, index) => (
          <span key={index} className={`h-2 w-2 rounded-full ${index < filled ? 'bg-orange-500' : 'bg-slate-200'}`} />
        ))}
      </span>
      <span className="text-xs text-slate-500" aria-hidden="true">Toward Can say it</span>
    </div>
  );
}

const OPEN_BUTTON = 'grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-200 hover:text-indigo-600';

export interface LoopCardFaceProps {
  item: StoredItem;
  card: LoopCard;
  step: CardStep;
  hintShown: boolean;
  mode: LoopMode;
  /** 'Second try' or 'One more look' on a run's card that came back. */
  attemptLabel: string | null;
  /** A practice item's graduation dots, once its answer shows; null for an item being met. */
  dots: number | null;
  /** ↗: the item in the card view or its sentence lesson, over the session. */
  onOpenItem: () => void;
  /** Hears each read the example's or sentence's speaker starts, so the session's audio can stop it. */
  onPlaybackStart: (handle: SpeakHandle) => void;
  onLazyLoadImage: (itemId: string, imageVersion?: string) => Promise<string | null>;
}

/**
 * One card of a set or practice session: the prompt and its cue (cues.ts loopCard), the hint once taken, and the answer
 * once revealed, under the cue, so showing it moves nothing. After Practice in a set, the answer stays while the item is
 * said twice.
 */
export function LoopCardFace({ item, card, step, hintShown, mode, attemptLabel, dots, onOpenItem, onPlaybackStart, onLazyLoadImage }: LoopCardFaceProps) {
  const { answer } = card;
  return (
    <div className="mx-auto max-w-2xl pb-6 pt-[5vh]">
      <p className={EYEBROW}>{attemptLabel ? `${attemptLabel} · ${card.prompt}` : card.prompt}</p>
      <CueBody cue={card.cue} item={item} onLazyLoadImage={onLazyLoadImage} />
      {card.note && <p className="mt-3 text-xs text-slate-500">{card.note}</p>}
      {hintShown && <HintBox hint={card.hint} />}

      {step !== 'cue' && (
        <section aria-live="polite" aria-label="Answer" className="mt-8 border-t border-slate-200 pt-6">
          {step === 'encode' && (
            <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
              {mode === 'speak' ? 'Say it twice, out loud' : 'Say it twice in your head'}
            </p>
          )}
          {answer.kind === 'word' ? (
            <>
              <div className="flex items-start gap-2">
                <h3 className="min-w-0 flex-1 break-words text-4xl font-bold text-slate-900">{answer.word}</h3>
                <button type="button" onClick={onOpenItem} className={OPEN_BUTTON} aria-label="Open the card" title="Open the card">
                  <ArrowUpRight size={20} />
                </button>
              </div>
              {answer.ipa && <div className="mt-2"><PronunciationBlock text={answer.word} ipa={answer.ipa} /></div>}
              {answer.sense && <p className="mt-2 text-sm text-slate-500">{answer.sense}</p>}
              {answer.chinese && <p className="mt-2 text-lg text-slate-700">{answer.chinese}</p>}
              {answer.definition && <p className="mt-1 text-sm leading-relaxed text-slate-600">{answer.definition}</p>}
              {answer.example && (
                <div className="mt-4 flex items-start gap-2 border-l-2 border-slate-300 pl-3">
                  <p className="min-w-0 flex-1 pt-1.5 text-sm leading-relaxed text-slate-600">
                    <Parts parts={answer.example.parts} mark="bg-transparent font-semibold text-slate-800" />
                  </p>
                  <SentenceSpeakerButton
                    text={answer.example.text}
                    iconSize={17}
                    onPlaybackStart={onPlaybackStart}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-md hover:bg-slate-200"
                  />
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 text-2xl font-semibold leading-snug text-slate-900">
                  <Parts parts={answer.parts} mark="rounded bg-violet-100 px-0.5 text-violet-950" />
                </p>
                <SentenceSpeakerButton
                  text={answer.text}
                  iconSize={20}
                  onPlaybackStart={onPlaybackStart}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-slate-200"
                />
                <button type="button" onClick={onOpenItem} className={OPEN_BUTTON} aria-label="Open the sentence lesson" title="Open the sentence lesson">
                  <ArrowUpRight size={20} />
                </button>
              </div>
              {answer.ipa && <p className="mt-2 text-sm text-slate-500">{answer.ipa}</p>}
              <p className="mt-3 text-base leading-relaxed text-slate-600">{answer.translation}</p>
            </>
          )}
          {dots !== null && <GraduationDots filled={dots} />}
        </section>
      )}
    </div>
  );
}
