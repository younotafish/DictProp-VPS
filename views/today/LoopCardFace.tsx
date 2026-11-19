import { Fragment } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { StoredItem } from '../../types';
import type { CardStep } from '../../services/learningLoop/session';
import type { LoopCard, LoopCue, LoopHint, LoopMode, TextPart } from '../../services/learningLoop/cues';
import { GRADUATION_DOTS } from '../../services/learningLoop/standing';
import type { SpeakHandle } from '../../services/neuralTts';
import { OfflineImage } from '../../components/OfflineImage';
import { SentenceSpeakerButton } from '../../components/SentenceSpeakerButton';

const EYEBROW = 'text-xs font-bold uppercase tracking-[0.18em] text-slate-400';

/** A sentence cut around its expression (cues.ts TextPart), the expression marked. */
function Parts({ parts, mark }: { parts: readonly TextPart[]; mark: string }) {
  return (
    <>
      {parts.map((part, index) => (
        part.target ? <mark key={index} className={mark}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>
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

/** The cue: the translation, large, then at level 1 the expression to use, or at level 2 the picture. */
function CueBody({ cue, item, onLazyLoadImage }: { cue: LoopCue; item: StoredItem; onLazyLoadImage: LoopCardFaceProps['onLazyLoadImage'] }) {
  return (
    <>
      <p className="mt-3 text-2xl font-semibold leading-snug text-slate-900">{cue.translation}</p>
      {cue.level === 1 && cue.expression && (
        <p className="mt-3 text-sm text-slate-600">
          Use <span className="rounded bg-violet-100 px-1.5 font-semibold text-violet-950">{cue.expression}</span>
        </p>
      )}
      {cue.level === 2 && cue.imageUrl && <Picture src={cue.imageUrl} item={item} onLazyLoadImage={onLazyLoadImage} />}
    </>
  );
}

/** The hint once taken: the first letter of each of the sentence's words. */
function HintBox({ hint }: { hint: LoopHint }) {
  return (
    <div className="mt-5 rounded-xl bg-indigo-50 px-4 py-3 text-indigo-950">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-400">Hint</p>
      <p className="mt-1 font-mono text-lg leading-relaxed tracking-wider">{hint.text}</p>
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
  /** ↗: the sentence in its lesson, over the session. */
  onOpenItem: () => void;
  /** Hears each read the sentence's speaker starts, so the session's audio can stop it. */
  onPlaybackStart: (handle: SpeakHandle) => void;
  onLazyLoadImage: (itemId: string, imageVersion?: string) => Promise<string | null>;
}

/**
 * One card of a set or practice session: the prompt, its cue (cues.ts loopCard) and what counts, the hint once taken,
 * and the answer once revealed, under the cue, so showing it moves nothing. After Practice in a set, the answer stays
 * while the sentence is said twice.
 */
export function LoopCardFace({ item, card, step, hintShown, mode, attemptLabel, dots, onOpenItem, onPlaybackStart, onLazyLoadImage }: LoopCardFaceProps) {
  const { answer } = card;
  return (
    <div className="mx-auto max-w-2xl pb-6 pt-[5vh]">
      <p className={EYEBROW}>{attemptLabel ? `${attemptLabel} · ${card.prompt}` : card.prompt}</p>
      <CueBody cue={card.cue} item={item} onLazyLoadImage={onLazyLoadImage} />
      <p className="mt-3 text-xs text-slate-500">{card.note}</p>
      {hintShown && <HintBox hint={card.hint} />}

      {step !== 'cue' && (
        <section aria-live="polite" aria-label="Answer" className="mt-8 border-t border-slate-200 pt-6">
          {step === 'encode' && (
            <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
              {mode === 'speak' ? 'Say it twice, out loud' : 'Say it twice in your head'}
            </p>
          )}
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
          {dots !== null && <GraduationDots filled={dots} />}
        </section>
      )}
    </div>
  );
}
