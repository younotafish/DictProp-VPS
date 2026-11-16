import React from 'react';
import { Check, Copy, X } from 'lucide-react';
import type { StoredItem } from '../../types';
import { HighlightedSentence } from '../../components/HighlightedSentence';
import { SentenceSpeakerButton } from '../../components/SentenceSpeakerButton';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { PLATFORM } from '../../services/platform';

export type SentenceCopyState = 'copied' | 'failed' | null;

interface SentenceHeroProps {
  /** 'split' sits beside an attached picture on wider screens; 'centered' has the page to itself. */
  layout: 'split' | 'centered';
  /** The sentence with its {{studied}} and [[uncommon]] markers. */
  text: string;
  sourceWord: string;
  /** The sentence's connected-speech IPA (services/sentencePronunciation.ts connectedSpeechIpa), shown under it. */
  connectedIpa?: string;
  findSaved?: (term: string) => StoredItem | null;
  onOpenCard?: (item: StoredItem) => void;
  onSearchWord: (text: string) => void;
  /** Command is held on a Mac, so the words preview the look-up a click would make. */
  commandHeld: boolean;
  /** The phone's word gestures, taken before the words' own handlers (see useSentenceGestures). */
  onWordTouchStartCapture?: React.TouchEventHandler<HTMLElement>;
  onWordClickCapture: React.MouseEventHandler<HTMLElement>;
  /** A laptop's pointerdown on the sentence, before a click inside a selection collapses it (useSelectionLookup). */
  onSentencePointerDownCapture?: React.PointerEventHandler<HTMLElement>;
  /** The speaker played the sentence to its end. */
  onListened: () => void;
  /** Takes the speaker's tap instead of its own play and pause: during auto-play, auto-play's pause. */
  onSpeakerToggle?: () => void;
  copyState: SentenceCopyState;
  onCopy: () => void;
}

/** What the connected-speech IPA line says to a screen reader, and on hover. */
const CONNECTED_IPA_LABEL = 'Natural American IPA (connected speech)';

/**
 * The sentence under review, the page's hero, with its connected-speech IPA under it when the analysis has one, then
 * its speaker, copy button and (on a Mac) the Command-click hint. Words play from where they're tapped or clicked and
 * look themselves up with a two-finger tap or Command/Ctrl-click; the handlers come from the view. The IPA line sits
 * outside the sentence's element, so it's no word and no part of a selection to look up.
 */
export function SentenceHero({
  layout, text, sourceWord, connectedIpa, findSaved, onOpenCard, onSearchWord, commandHeld,
  onWordTouchStartCapture, onWordClickCapture, onSentencePointerDownCapture, onListened, onSpeakerToggle, copyState, onCopy,
}: SentenceHeroProps) {
  const { isMobile, isMacDesktop } = PLATFORM;
  const split = layout === 'split';
  return (
    <>
      <p
        data-sentence-hero
        className={split
          ? `text-center md:text-left font-normal leading-relaxed tracking-tight text-slate-800 cursor-pointer select-text ${commandHeld ? 'sentence-command-lookup-active' : ''} text-xl sm:text-3xl`
          : `max-w-2xl mx-auto text-center font-normal leading-relaxed tracking-tight text-slate-800 cursor-pointer select-text ${commandHeld ? 'sentence-command-lookup-active' : ''} text-2xl sm:text-4xl`}
        onTouchStartCapture={onWordTouchStartCapture}
        onPointerDownCapture={onSentencePointerDownCapture}
        onClickCapture={onWordClickCapture}
        title={isMobile
          ? 'Tap a word to play from it · two-finger tap a word to look it up'
          : isMacDesktop
            ? 'Click a word to play from it · Command-click to look it up · click blank space to play/pause'
            : 'Click a word to play from it · Ctrl-click to look it up · click blank space to play/pause'}
      >
        <HighlightedSentence
          text={text}
          itemWord={sourceWord}
          findSaved={findSaved}
          onOpenCard={onOpenCard}
          onSearchWord={onSearchWord}
          searchAnyWord
        />
      </p>
      {/* No line, and no space for one, without the IPA. */}
      {connectedIpa && (
        <p
          role="note"
          className={split
            ? 'mt-3 text-center md:text-left font-mono text-sm sm:text-base leading-relaxed text-indigo-700 break-words'
            : 'mt-3 max-w-2xl mx-auto text-center font-mono text-sm sm:text-base leading-relaxed text-indigo-700 break-words'}
          title={CONNECTED_IPA_LABEL}
          aria-label={CONNECTED_IPA_LABEL}
        >
          {connectedIpa}
        </p>
      )}
      <div className={split ? 'mt-5 flex flex-wrap items-center justify-center md:justify-start gap-3' : 'mt-5 flex flex-wrap items-center justify-center gap-3'}>
        <SentenceSpeakerButton
          text={stripSentenceMarkers(text)}
          onComplete={onListened}
          onToggle={onSpeakerToggle}
        />
        {/* Copies the plain sentence, to paste into Meta AI or anywhere. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCopy(); }}
          className={`p-2.5 -m-2 transition-colors ${copyState === 'copied' ? 'text-emerald-500' : copyState === 'failed' ? 'text-rose-500' : 'text-indigo-300 hover:text-indigo-600'}`}
          title={copyState === 'copied' ? 'Copied — paste it into Meta AI' : copyState === 'failed' ? "Couldn't copy — select the sentence and copy it instead" : 'Copy sentence (to paste into Meta AI)'}
        >
          {copyState === 'copied' ? <Check size={14} /> : copyState === 'failed' ? <X size={14} /> : <Copy size={14} />}
        </button>
        {isMacDesktop && (
          <span
            className={`hidden h-6 w-6 items-center justify-center rounded-full text-xs font-semibold transition-colors sm:inline-flex ${commandHeld ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}`}
            title="Command-click a word to look it up"
            aria-label="Command-click a word to look it up"
            onClick={(e) => e.stopPropagation()}
          >
            <kbd className="font-sans">⌘</kbd>
          </span>
        )}
      </div>
    </>
  );
}
