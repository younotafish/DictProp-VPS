/**
 * Sentence auto-play's reading as a state machine, apart from React and the engine so node tests can drive it. It reads
 * each card's texts in turn, each as many times as asked with a gap between reads, then moves to the next card. It can
 * pause and resume anywhere (mid-read, while a clip loads, in a gap), hears when something else ends a read or speaks
 * in a gap, reads the current text again in a new voice, and lets the read under way finish when the Duration timer
 * runs out. reduceAutoplay decides; createAutoplayController carries the decisions out through injected
 * dependencies (the engine, the gap timer, the settings), and createSessionClock is the pause-aware countdown.
 * Type-only imports, so loading it loads nothing else.
 */
import type { InterruptReason, PlaybackStatus } from './player';

/**
 * Sentence review reads one sentence per card and pauses when something else speaks; word cards read their examples
 * and stop then, as an eyes-free tap on another example already does.
 */
export type AutoplayMode = 'sentence-review' | 'word-cards';

/** Where the reading is: waiting for a card, a read loading or playing, the gap after one, paused, or over for good. */
export type AutoplayPhase = 'idle' | 'loading' | 'reading' | 'gap' | 'paused' | 'ended';

/**
 * What a resume does: play on the clip the engine holds paused ('clip'), read the current text again from its start
 * ('read', after an interruption cut the read off), or take the step the paused gap was waiting for ('step').
 */
export type ResumeKind = 'clip' | 'read' | 'step';

/** The short beat between word cards, after a card's last read. Sentence review waits its gap between cards too. */
export const CARD_GAP_MS = 600;
/** How long a card with nothing to read stays before the next one. */
export const EMPTY_CARD_MS = 400;

/** The settings read as the reading goes: times each text is read, and the silence between reads. */
export interface AutoplaySettings {
  repeats: number;
  gapMs: number;
}

/** What comes after a read or a gap: a read (the same text again, or the next one), or the next card. */
export type NextStep =
  | { kind: 'read'; textIndex: number; repeat: number; successfulReads: number }
  | { kind: 'advance' };

export interface AutoplayState {
  mode: AutoplayMode;
  phase: AutoplayPhase;
  /** The card's texts, read in turn. */
  texts: readonly string[];
  textIndex: number;
  /** Reads of the current text already finished this round, so the read under way is number repeat + 1. */
  repeat: number;
  /** How many of them reached their end; a round heard in full is a listen in sentence review. */
  successfulReads: number;
  /** Counts every read and gap started; a callback from an earlier one carries an older turn and is ignored. */
  turn: number;
  /** While paused: what a resume does. */
  resume: ResumeKind | null;
  /** While paused: the phase the pause interrupted, which a resume of the paused clip returns to. */
  pausedFrom: 'loading' | 'reading' | 'gap' | null;
  /** The step a gap waits for, kept through a pause in the gap. */
  pendingStep: NextStep | null;
  /** The Duration timer ran out mid-read: that read finishes, then auto-play ends. */
  endAfterRead: boolean;
}

export type AutoplayCommand =
  | { type: 'startCard'; texts: readonly string[] }
  | { type: 'cancelCard' }
  | { type: 'pause' }
  | { type: 'resume'; clipPaused: boolean }
  | { type: 'interrupt'; turn: number; reason: InterruptReason }
  | { type: 'readEnded'; turn: number; ok: boolean; settings: AutoplaySettings }
  | { type: 'gapEnded'; turn: number }
  | { type: 'engineState'; status: PlaybackStatus; ours: boolean }
  | { type: 'restartRead' }
  | { type: 'timerEnded' }
  | { type: 'stop' };

export type AutoplayEffect =
  /** Read `text` as turn `turn`. */
  | { type: 'speak'; text: string; turn: number }
  /** The owner's stop of the read under way (which never counts as an interruption). */
  | { type: 'stopRead' }
  | { type: 'pauseClip' }
  | { type: 'resumeClip' }
  /** Wait `ms` (the gap of turn `turn`), holding the engine meanwhile so other speech is heard as an interruption. */
  | { type: 'wait'; ms: number; turn: number }
  /** Stop waiting and let go of the engine. */
  | { type: 'cancelWait' }
  /** Hold the engine again for the gap under way (a style change ended the previous hold). */
  | { type: 'renewHold'; turn: number }
  | { type: 'advance' }
  /** Auto-play is over: the view turns it off. */
  | { type: 'finish' }
  | { type: 'roundListened' }
  /** Re-arm what keeps a session going after a pause: the silent keep-alive and the wake lock. */
  | { type: 'rearm' };

export interface AutoplayTransition {
  state: AutoplayState;
  effects: AutoplayEffect[];
}

export const initialAutoplayState = (mode: AutoplayMode): AutoplayState => ({
  mode, phase: 'idle', texts: [], textIndex: 0, repeat: 0, successfulReads: 0, turn: 0, resume: null, pausedFrom: null,
  pendingStep: null, endAfterRead: false,
});

const unchanged = (state: AutoplayState): AutoplayTransition => ({ state, effects: [] });

/** Read texts[textIndex] as a new turn. */
const read = (state: AutoplayState, step: { textIndex: number; repeat: number; successfulReads: number }, effects: AutoplayEffect[]): AutoplayTransition => {
  const turn = state.turn + 1;
  return {
    state: { ...state, ...step, phase: 'loading', turn, resume: null, pausedFrom: null, pendingStep: null },
    effects: [...effects, { type: 'speak', text: state.texts[step.textIndex], turn }],
  };
};

/** Wait `ms` as a new turn, then take `step`. */
const wait = (state: AutoplayState, ms: number, step: NextStep, effects: AutoplayEffect[]): AutoplayTransition => {
  const turn = state.turn + 1;
  return {
    state: { ...state, phase: 'gap', turn, resume: null, pausedFrom: null, pendingStep: step },
    effects: [...effects, { type: 'wait', ms, turn }],
  };
};

const takeStep = (state: AutoplayState, step: NextStep, effects: AutoplayEffect[]): AutoplayTransition =>
  step.kind === 'advance'
    ? { state: { ...state, phase: 'idle', resume: null, pausedFrom: null, pendingStep: null }, effects: [...effects, { type: 'advance' }] }
    : read(state, step, effects);

const finish = (state: AutoplayState, effects: AutoplayEffect[]): AutoplayTransition => ({
  state: { ...state, phase: 'ended', resume: null, pausedFrom: null, pendingStep: null },
  effects: [...effects, { type: 'finish' }],
});

/** After a read of the current text: the same text again until it's been read `repeats` times, then the next text, then the next card. */
const stepAfterRead = (state: AutoplayState, successfulReads: number, repeats: number): NextStep => {
  if (state.repeat + 1 < repeats) return { kind: 'read', textIndex: state.textIndex, repeat: state.repeat + 1, successfulReads };
  if (state.textIndex + 1 < state.texts.length) return { kind: 'read', textIndex: state.textIndex + 1, repeat: 0, successfulReads: 0 };
  return { kind: 'advance' };
};

const isReadUnderWay = (state: AutoplayState): boolean => state.phase === 'loading' || state.phase === 'reading';

/** The next state of the reading, and what to do about it. Never mutates `state`. */
export function reduceAutoplay(state: AutoplayState, command: AutoplayCommand): AutoplayTransition {
  if (command.type === 'stop') {
    return {
      state: { ...state, phase: 'ended', resume: null, pausedFrom: null, pendingStep: null },
      effects: [{ type: 'stopRead' }, { type: 'cancelWait' }],
    };
  }
  if (state.phase === 'ended') return unchanged(state);

  switch (command.type) {
    case 'startCard': {
      // A new card always plays, though the previous one was paused: only a pause on this card holds it.
      const fresh: AutoplayState = { ...state, texts: command.texts, textIndex: 0, repeat: 0, successfulReads: 0 };
      const effects: AutoplayEffect[] = [{ type: 'stopRead' }, { type: 'cancelWait' }];
      return command.texts.length
        ? read(fresh, { textIndex: 0, repeat: 0, successfulReads: 0 }, effects)
        : wait(fresh, EMPTY_CARD_MS, { kind: 'advance' }, effects);
    }

    case 'cancelCard':
      if (state.phase === 'idle') return unchanged(state);
      return {
        state: { ...state, phase: 'idle', resume: null, pausedFrom: null, pendingStep: null },
        effects: [{ type: 'stopRead' }, { type: 'cancelWait' }],
      };

    case 'pause':
      if (isReadUnderWay(state)) {
        // The engine pauses the clip, or keeps a clip still loading from starting; a resume plays it on.
        return { state: { ...state, phase: 'paused', pausedFrom: state.phase as 'loading' | 'reading', resume: 'clip' }, effects: [{ type: 'pauseClip' }] };
      }
      if (state.phase === 'gap') {
        // The gap's step waits for the resume, which takes it at once.
        return { state: { ...state, phase: 'paused', pausedFrom: 'gap', resume: 'step' }, effects: [{ type: 'cancelWait' }] };
      }
      return unchanged(state);

    case 'resume': {
      if (state.phase !== 'paused') return unchanged(state);
      const effects: AutoplayEffect[] = [{ type: 'rearm' }];
      const resumed: AutoplayState = { ...state, resume: null, pausedFrom: null };
      if (state.resume === 'clip' && command.clipPaused) {
        return { state: { ...resumed, phase: state.pausedFrom === 'loading' ? 'loading' : 'reading' }, effects: [...effects, { type: 'resumeClip' }] };
      }
      if (state.resume === 'step' && state.pendingStep) return takeStep(resumed, state.pendingStep, effects);
      // An interrupted read, or a paused clip the engine no longer holds: read the text again from its start. The read
      // that was cut off doesn't count.
      return read(resumed, state, [...effects, { type: 'stopRead' }]);
    }

    case 'interrupt': {
      if (command.turn !== state.turn || state.phase === 'idle') return unchanged(state);
      if (state.mode === 'word-cards') return finish(state, [{ type: 'stopRead' }, { type: 'cancelWait' }]);
      if (state.phase === 'gap') {
        return { state: { ...state, phase: 'paused', pausedFrom: 'gap', resume: 'step' }, effects: [{ type: 'cancelWait' }] };
      }
      if (state.phase === 'paused' && state.resume !== 'clip') return unchanged(state);
      // The read (loading, playing or paused) is gone: a resume reads it again from its start.
      const pausedFrom = state.phase === 'paused' ? state.pausedFrom : state.phase as 'loading' | 'reading';
      return { state: { ...state, phase: 'paused', pausedFrom, resume: 'read' }, effects: [{ type: 'stopRead' }] };
    }

    case 'readEnded': {
      const clipPaused = state.phase === 'paused' && state.resume === 'clip';
      if (command.turn !== state.turn || !(isReadUnderWay(state) || clipPaused)) return unchanged(state);
      const { repeats, gapMs } = command.settings;
      const successfulReads = state.successfulReads + (command.ok ? 1 : 0);
      const effects: AutoplayEffect[] = [];
      // A round heard to its end, every repeat of it, is a listen of the sentence under review.
      if (command.ok && state.mode === 'sentence-review' && state.repeat + 1 >= repeats && successfulReads >= repeats) {
        effects.push({ type: 'roundListened' });
      }
      const counted: AutoplayState = { ...state, successfulReads };
      if (state.endAfterRead) return finish(counted, effects);
      const step = stepAfterRead(state, successfulReads, repeats);
      // A pause the engine couldn't hold (a voice that read on): the read counts, and the resume takes the next step.
      if (clipPaused) return { state: { ...counted, pausedFrom: 'gap', resume: 'step', pendingStep: step }, effects };
      return wait(counted, step.kind === 'read' || state.mode === 'sentence-review' ? gapMs : CARD_GAP_MS, step, effects);
    }

    case 'gapEnded':
      if (command.turn !== state.turn || state.phase !== 'gap' || !state.pendingStep) return unchanged(state);
      return takeStep(state, state.pendingStep, [{ type: 'cancelWait' }]);

    case 'engineState':
      if (!command.ours) return unchanged(state);
      if (command.status === 'playing') {
        if (state.phase === 'loading') return { state: { ...state, phase: 'reading' }, effects: [] };
        // Something else resumed the paused clip (the OS, another control): the reading goes on with it.
        if (state.phase === 'paused' && state.resume === 'clip') {
          return { state: { ...state, phase: 'reading', resume: null, pausedFrom: null }, effects: [{ type: 'rearm' }] };
        }
        return unchanged(state);
      }
      // A pause it didn't ask for (the OS, a headset, another control): paused, and a resume plays the clip on.
      if (command.status === 'paused' && isReadUnderWay(state)) {
        return { state: { ...state, phase: 'paused', pausedFrom: state.phase as 'loading' | 'reading', resume: 'clip' }, effects: [] };
      }
      return unchanged(state);

    case 'restartRead':
      // A new voice: the read under way starts again in it, its repeat count kept; a paused clip is read again on
      // resume; a gap holds the engine again (the change of style ended the hold) and carries on.
      if (isReadUnderWay(state)) return read(state, state, [{ type: 'stopRead' }]);
      if (state.phase === 'paused' && state.resume === 'clip') return { state: { ...state, resume: 'read' }, effects: [{ type: 'stopRead' }] };
      if (state.phase === 'gap') return { state, effects: [{ type: 'renewHold', turn: state.turn }] };
      return unchanged(state);

    case 'timerEnded':
      if (isReadUnderWay(state)) return state.endAfterRead ? unchanged(state) : { state: { ...state, endAfterRead: true }, effects: [] };
      return finish(state, [{ type: 'stopRead' }, { type: 'cancelWait' }]);
  }
}

/** What a read the runner starts returns: the owner's stop, and whether the read still owns the engine. */
export interface ReadHandle {
  stop: () => void;
  isActive: () => boolean;
}

export interface AutoplayDeps {
  mode: AutoplayMode;
  /** Start reading `text`. Exactly one of the callbacks is called, unless the owner stops the read first. */
  speak: (text: string, callbacks: { onEnd: () => void; onError: () => void; onInterrupted: (reason: InterruptReason) => void }) => ReadHandle;
  /** Pause the read under way: the playing clip, or one still loading before it starts. */
  pauseClip: () => void;
  resumeClip: () => void;
  /** The engine's status now, to tell whether it still holds the paused clip. */
  playbackStatus: () => PlaybackStatus;
  /** Call `done` after `ms`; the returned function cancels it. */
  afterGap: (ms: number, done: () => void) => () => void;
  /** Hold the engine through a gap: `onInterrupted` hears the next speech or stop by anyone; the result lets go. */
  reserve?: (onInterrupted: (reason: InterruptReason) => void) => () => void;
  settings: () => AutoplaySettings;
  finish: () => void;
  roundListened?: () => void;
  rearm?: () => void;
}

export interface AutoplayController {
  getState: () => AutoplayState;
  /** Hears every change of state; the returned function stops. */
  subscribe: (listener: () => void) => () => void;
  /** Read the card on screen; `advance` moves to the next card (or ends auto-play after the last). */
  startCard: (texts: readonly string[], advance: () => void) => void;
  /** The card is leaving: stop its read or gap, without ending auto-play. */
  cancelCard: () => void;
  pause: () => void;
  resume: () => void;
  togglePause: () => void;
  /** The engine's status changed. */
  engineState: (status: PlaybackStatus) => void;
  /** The speech style changed: read the current text again in the new one. */
  restartRead: () => void;
  timerEnded: () => void;
  /** Auto-play is off: stop everything, for good. */
  stop: () => void;
}

/** A controller for one auto-play session, carrying reduceAutoplay's decisions out through `deps`. */
export function createAutoplayController(deps: AutoplayDeps): AutoplayController {
  let state = initialAutoplayState(deps.mode);
  const listeners = new Set<() => void>();
  let readHandle: ReadHandle | null = null;
  let cancelGap: (() => void) | null = null;
  let releaseHold: (() => void) | null = null;
  let advance: (() => void) | null = null;

  const hold = (turn: number) => {
    releaseHold?.();
    releaseHold = deps.reserve?.(reason => dispatch({ type: 'interrupt', turn, reason })) ?? null;
  };
  const clearWait = () => {
    cancelGap?.();
    cancelGap = null;
    releaseHold?.();
    releaseHold = null;
  };
  const run = (effect: AutoplayEffect): void => {
    switch (effect.type) {
      case 'speak': {
        const { turn } = effect;
        let handle: ReadHandle | null = null;
        const ended = (ok: boolean) => {
          if (readHandle === handle) readHandle = null;
          dispatch({ type: 'readEnded', turn, ok, settings: deps.settings() });
        };
        handle = deps.speak(effect.text, {
          onEnd: () => ended(true),
          onError: () => ended(false),
          onInterrupted: reason => dispatch({ type: 'interrupt', turn, reason }),
        });
        readHandle = handle;
        // Nothing to read (a blank text): a failed read, so the reading moves on rather than waiting for good.
        if (!handle.isActive()) queueMicrotask(() => { if (readHandle === handle) ended(false); });
        return;
      }
      case 'stopRead': {
        const handle = readHandle;
        readHandle = null;
        handle?.stop();
        return;
      }
      case 'pauseClip': deps.pauseClip(); return;
      case 'resumeClip': deps.resumeClip(); return;
      case 'wait': {
        clearWait();
        const { turn } = effect;
        cancelGap = deps.afterGap(effect.ms, () => dispatch({ type: 'gapEnded', turn }));
        hold(turn);
        return;
      }
      case 'cancelWait': clearWait(); return;
      case 'renewHold': hold(effect.turn); return;
      case 'advance': advance?.(); return;
      case 'finish': deps.finish(); return;
      case 'roundListened': deps.roundListened?.(); return;
      case 'rearm': deps.rearm?.(); return;
    }
  };

  function dispatch(command: AutoplayCommand): void {
    const { state: next, effects } = reduceAutoplay(state, command);
    if (next !== state) {
      state = next;
      for (const listener of [...listeners]) listener();
    }
    for (const effect of effects) run(effect);
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    startCard: (texts, next) => {
      advance = next;
      dispatch({ type: 'startCard', texts });
    },
    cancelCard: () => dispatch({ type: 'cancelCard' }),
    pause: () => dispatch({ type: 'pause' }),
    resume: () => dispatch({ type: 'resume', clipPaused: !!readHandle?.isActive() && deps.playbackStatus() === 'paused' }),
    togglePause: () => {
      if (state.phase === 'paused') dispatch({ type: 'resume', clipPaused: !!readHandle?.isActive() && deps.playbackStatus() === 'paused' });
      else dispatch({ type: 'pause' });
    },
    engineState: status => dispatch({ type: 'engineState', status, ours: !!readHandle?.isActive() }),
    restartRead: () => dispatch({ type: 'restartRead' }),
    timerEnded: () => dispatch({ type: 'timerEnded' }),
    stop: () => {
      advance = null;
      dispatch({ type: 'stop' });
    },
  };
}

/** The pause-aware clock behind the Duration countdown: time spent paused doesn't count. */
export interface SessionClock {
  start: () => void;
  pause: () => void;
  resume: () => void;
  /** Running time since start, less the pauses. */
  elapsedMs: () => number;
  remainingMs: (durationMs: number) => number;
  /** When a session of `durationMs` ends at this pace: null while paused (the countdown stands still) or before start. */
  deadline: (durationMs: number) => number | null;
  isPaused: () => boolean;
}

export function createSessionClock(now: () => number): SessionClock {
  let startedAt: number | null = null;
  let pausedAt: number | null = null;
  let pausedMs = 0;
  const elapsedMs = () => (startedAt === null ? 0 : (pausedAt ?? now()) - startedAt - pausedMs);
  return {
    start: () => { startedAt = now(); pausedAt = null; pausedMs = 0; },
    pause: () => { if (startedAt !== null && pausedAt === null) pausedAt = now(); },
    resume: () => {
      if (pausedAt === null) return;
      pausedMs += now() - pausedAt;
      pausedAt = null;
    },
    elapsedMs,
    remainingMs: durationMs => Math.max(0, durationMs - elapsedMs()),
    deadline: durationMs => (startedAt === null || pausedAt !== null ? null : startedAt + pausedMs + durationMs),
    isPaused: () => pausedAt !== null,
  };
}
