import type { SRSData } from '../../types';
import type { StudyDevice, StudyEvent, StudyExit, StudySrsSnapshot } from '../../server/src/shared/study-events';
import {
  MAX_LOOKUP_TERM_LENGTH, MAX_LOOKUP_TERMS, STUDY_EVENT_VERSION, STUDY_IDLE_CAP_MS,
} from '../../server/src/shared/study-events';

// One exposure of a sentence in the lesson, counted as it runs: what useStudySignals feeds it, apart from React so node
// tests can pin the arithmetic. Time counts only while the lesson is attended (the page visible and its window
// focused). Engaged time, and the analysis time within it, also leaves out the learner
// being away with the screen on: each gap between two actions counts for at most STUDY_IDLE_CAP_MS, except while the
// sentence's audio plays, which is listening.

/** An exposure this short, with nothing done in it, is a sentence passed over on the way to another: not kept. */
export const MIN_KEPT_VISIBLE_MS = 300;

export interface ExposureStart {
  id: string;
  itemId: string;
  sessionId?: string;
  from?: string;
  position: number;
  runLength: number;
  learnLater: boolean;
  srs: SRSData | undefined;
  /** Whether the device had read the server's stars when it began (learnLater false then means not starred). */
  learnLaterKnown?: boolean;
  device?: StudyDevice;
  standalone?: boolean;
}

const MAX_MS = 7 * 24 * 3_600_000;
const whole = (ms: number) => Math.min(MAX_MS, Math.max(0, Math.round(ms)));

function srsSnapshot(srs: SRSData | undefined): StudySrsSnapshot {
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
  return {
    totalReviews: count(srs?.totalReviews) ? srs!.totalReviews : 0,
    stability: finite(srs?.stability) ? srs!.stability : 0,
    lastReviewDate: finite(srs?.lastReviewDate) ? Math.round(srs!.lastReviewDate) : 0,
    nextReview: finite(srs?.nextReview) ? Math.round(srs!.nextReview) : 0,
    ...(finite(srs?.difficulty) ? { difficulty: srs!.difficulty } : {}),
    ...(count(srs?.lapses) ? { lapses: srs!.lapses } : {}),
  };
}

export class StudyExposure {
  readonly start: ExposureStart;
  readonly startedAt: number;
  private readonly tzOffset: number;
  private readonly srs: StudySrsSnapshot;
  private visibleAcc = 0;
  private visibleSince: number | null;
  private engagedAcc = 0;
  /**
   * The last evidence the learner is there: an action, or the lesson coming back into attention (the exposure's start
   * included). Engaged time outside playback runs to at most STUDY_IDLE_CAP_MS past it; playback never renews it, so
   * audio in the middle of an idle gap adds its own length and no fresh allowance.
   */
  private lastAction: number;
  /** Engaged time is banked up to here. */
  private settledAt: number;
  private playing = false;
  private analysisOpen = false;
  private analysisAcc = 0;
  private counts = {
    analysisOpens: 0, plays: 0, autoPlays: 0, listens: 0, listensAway: 0, styleSwitches: 0, lookups: 0, cardOpens: 0, gotIts: 0,
  };
  private lookupTerms: string[] = [];
  private firstGotItMs: number | undefined;
  private learnLater: boolean;
  private learnLaterToggles = 0;
  private autoplay = false;
  /** The wall-clock time the exposure began; every duration runs on the `now` clock the caller passes (monotonic). */
  private readonly wallStart: number;

  /**
   * `now` is the caller's clock, monotonic in the app (performance.now()), so a device clock set back or forward
   * mid-exposure can't bend a duration; `wallStart` is the wall-clock time it began (startedAt and endedAt). `lastAction`
   * is the learner's last action before it began: an auto-play move carries the idle allowance across sentences,
   * rather than granting each a fresh minute.
   */
  constructor(
    start: ExposureStart, now: number, visible: boolean, tzOffset?: number,
    { wallStart = now, lastAction = now }: { wallStart?: number; lastAction?: number } = {},
  ) {
    // Minutes east of UTC at the wall-clock moment it began, unless given.
    tzOffset ??= -new Date(wallStart).getTimezoneOffset();
    this.start = start;
    this.startedAt = now;
    this.wallStart = wallStart;
    this.visibleSince = visible ? now : null;
    this.lastAction = Math.min(now, lastAction);
    this.settledAt = now;
    this.tzOffset = Math.max(-840, Math.min(840, Math.round(tzOffset)));
    this.srs = srsSnapshot(start.srs);
    this.learnLater = start.learnLater;
  }

  private visibleMs(now: number): number {
    return this.visibleAcc + (this.visibleSince === null ? 0 : Math.max(0, now - this.visibleSince));
  }

  /** The engaged time since settledAt, by the rule in force since then. */
  private pendingEngaged(now: number): number {
    if (this.visibleSince === null) return 0;
    if (this.playing) return Math.max(0, now - this.settledAt);
    return Math.max(0, Math.min(now, this.lastAction + STUDY_IDLE_CAP_MS) - this.settledAt);
  }

  private engagedMs(now: number): number {
    return this.engagedAcc + this.pendingEngaged(now);
  }

  /** Banks the engaged time so far under the rule in force, so a change of rule starts from `now`. */
  private settleEngaged(now: number): void {
    const pending = this.pendingEngaged(now);
    this.engagedAcc += pending;
    if (this.analysisOpen) this.analysisAcc += pending;
    this.settledAt = Math.max(this.settledAt, now);
  }

  /** The learner did something (a tap, a key, a scroll, a swipe): an idle gap ends here. */
  noteActivity(now: number): void {
    this.settleEngaged(now);
    this.lastAction = Math.max(this.lastAction, now);
  }

  /** Whether the lesson is attended now. */
  get attended(): boolean {
    return this.visibleSince !== null;
  }

  /** The sentence's audio started or stopped playing: time while it plays is engaged however long. */
  setPlaying(playing: boolean, now: number): void {
    if (playing === this.playing) return;
    this.settleEngaged(now);
    this.playing = playing;
  }

  /** Engaged time with the analysis page open, under the same idle cap. */
  private analysisMs(now: number): number {
    return this.analysisAcc + (this.analysisOpen ? this.pendingEngaged(now) : 0);
  }

  /** Whether the lesson is attended: the page visible and its window focused. */
  setVisible(visible: boolean, now: number): void {
    if (visible === (this.visibleSince !== null)) return;
    this.settleEngaged(now);
    if (visible) {
      this.visibleSince = now;
      // Coming back to the lesson is evidence the learner is there.
      this.lastAction = Math.max(this.lastAction, now);
    } else {
      this.visibleAcc += Math.max(0, now - (this.visibleSince ?? now));
      this.visibleSince = null;
    }
  }

  setAnalysisOpen(open: boolean, now: number): void {
    if (open === this.analysisOpen) return;
    this.settleEngaged(now);
    this.analysisOpen = open;
    if (open) this.counts.analysisOpens++;
  }

  notePlay(byAutoPlay: boolean): void {
    if (byAutoPlay) this.counts.autoPlays++;
    else this.counts.plays++;
  }

  /** A read heard to its end: with the lesson attended, or (listensAway) with the learner elsewhere, as auto-play reads
   *  on behind another app or a locked screen. */
  noteListen(): void {
    if (this.visibleSince !== null) this.counts.listens++;
    else this.counts.listensAway++;
  }
  noteStyleSwitch(): void { this.counts.styleSwitches++; }
  noteCardOpen(): void { this.counts.cardOpens++; }
  noteAutoplay(): void { this.autoplay = true; }
  /** The star as it stands; `byLearner` for a toggle made in this lesson (counted), not one synced from elsewhere. */
  setLearnLater(on: boolean, byLearner = false): void {
    if (on !== this.learnLater && byLearner) this.learnLaterToggles++;
    this.learnLater = on;
  }

  noteLookup(term: string): void {
    this.counts.lookups++;
    const trimmed = term.trim().slice(0, MAX_LOOKUP_TERM_LENGTH);
    if (trimmed && this.lookupTerms.length < MAX_LOOKUP_TERMS) this.lookupTerms.push(trimmed);
  }

  noteGotIt(now: number): void {
    this.counts.gotIts++;
    this.settleEngaged(now);
    if (this.firstGotItMs === undefined) this.firstGotItMs = whole(this.engagedMs(now));
  }

  /** Whether the exposure is worth keeping: long enough to have been read, or something was done in it. */
  worthKeeping(now: number): boolean {
    if (this.visibleMs(now) >= MIN_KEPT_VISIBLE_MS || this.learnLaterToggles > 0) return true;
    return Object.values(this.counts).some(count => count > 0);
  }

  /** The exposure as an event at `now`: `final` once it has ended, else a copy taken while it runs. */
  snapshot(now: number, exit: StudyExit, final: boolean): StudyEvent {
    const visibleMs = whole(this.visibleMs(now));
    const { start } = this;
    return {
      id: start.id,
      itemId: start.itemId,
      ...(start.sessionId ? { sessionId: start.sessionId } : {}),
      ...(start.from ? { from: start.from.slice(0, 40) } : {}),
      startedAt: Math.round(this.wallStart),
      endedAt: Math.round(this.wallStart + Math.max(0, now - this.startedAt)),
      final,
      visibleMs,
      engagedMs: Math.min(visibleMs, whole(this.engagedMs(now))),
      version: STUDY_EVENT_VERSION,
      ...(start.learnLaterKnown !== undefined ? { learnLaterKnown: start.learnLaterKnown } : {}),
      ...(start.device ? { device: start.device } : {}),
      ...(start.standalone !== undefined ? { standalone: start.standalone } : {}),
      analysisMs: Math.min(visibleMs, whole(this.analysisMs(now)), whole(this.engagedMs(now))),
      ...this.counts,
      lookupTerms: [...this.lookupTerms],
      ...(this.firstGotItMs !== undefined ? { firstGotItMs: this.firstGotItMs } : {}),
      learnLater: this.learnLater,
      ...(this.learnLaterToggles > 0 ? { learnLaterToggles: this.learnLaterToggles } : {}),
      learnLaterAtStart: start.learnLater,
      autoplay: this.autoplay,
      exit,
      position: Math.max(1, Math.round(start.position)),
      runLength: Math.max(0, Math.round(start.runLength)),
      tzOffset: this.tzOffset,
      srs: this.srs,
    };
  }
}

/**
 * How the lesson left one sentence for another without a move the learner made: auto-play's move, which only ever goes
 * forward; else by place in the run, and 'other' when the place didn't change or there's no next sentence. A sentence
 * deleted at the end of the run while auto-play is on falls back one place: 'prev', never 'auto'.
 */
export function exitBetween(fromPosition: number, toPosition: number | null, autoPlaying: boolean): StudyExit {
  if (toPosition === null || toPosition === fromPosition) return 'other';
  if (toPosition < fromPosition) return 'prev';
  return autoPlaying ? 'auto' : 'next';
}
