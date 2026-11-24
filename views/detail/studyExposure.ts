import type { SRSData } from '../../types';
import type { StudyEvent, StudyExit, StudySrsSnapshot } from '../../server/src/shared/study-events';
import { MAX_LOOKUP_TERM_LENGTH, MAX_LOOKUP_TERMS } from '../../server/src/shared/study-events';

// One exposure of a sentence in the lesson, counted as it runs: what useStudySignals feeds it, apart from React so node
// tests can pin the arithmetic. Time counts only while the page is visible, and analysis time only while the analysis
// page is open on a visible page.

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
  private analysisOpen = false;
  private analysisAcc = 0;
  private analysisSince: number | null = null;
  private counts = {
    analysisOpens: 0, plays: 0, autoPlays: 0, listens: 0, styleSwitches: 0, lookups: 0, cardOpens: 0, gotIts: 0,
  };
  private lookupTerms: string[] = [];
  private firstGotItMs: number | undefined;
  private learnLater: boolean;
  private autoplay = false;

  constructor(start: ExposureStart, now: number, visible: boolean, tzOffset = -new Date(now).getTimezoneOffset()) {
    this.start = start;
    this.startedAt = now;
    this.visibleSince = visible ? now : null;
    this.tzOffset = Math.max(-840, Math.min(840, Math.round(tzOffset)));
    this.srs = srsSnapshot(start.srs);
    this.learnLater = start.learnLater;
  }

  private visibleMs(now: number): number {
    return this.visibleAcc + (this.visibleSince === null ? 0 : Math.max(0, now - this.visibleSince));
  }

  private analysisMs(now: number): number {
    return this.analysisAcc + (this.analysisSince === null ? 0 : Math.max(0, now - this.analysisSince));
  }

  private settleAnalysis(now: number): void {
    if (this.analysisSince !== null) this.analysisAcc += Math.max(0, now - this.analysisSince);
    this.analysisSince = this.analysisOpen && this.visibleSince !== null ? now : null;
  }

  setVisible(visible: boolean, now: number): void {
    if (visible === (this.visibleSince !== null)) return;
    if (visible) {
      this.visibleSince = now;
    } else {
      this.visibleAcc += Math.max(0, now - (this.visibleSince ?? now));
      this.visibleSince = null;
    }
    this.settleAnalysis(now);
  }

  setAnalysisOpen(open: boolean, now: number): void {
    if (open === this.analysisOpen) return;
    this.analysisOpen = open;
    if (open) this.counts.analysisOpens++;
    this.settleAnalysis(now);
  }

  notePlay(byAutoPlay: boolean): void {
    if (byAutoPlay) this.counts.autoPlays++;
    else this.counts.plays++;
  }

  noteListen(): void { this.counts.listens++; }
  noteStyleSwitch(): void { this.counts.styleSwitches++; }
  noteCardOpen(): void { this.counts.cardOpens++; }
  noteAutoplay(): void { this.autoplay = true; }
  setLearnLater(on: boolean): void { this.learnLater = on; }

  noteLookup(term: string): void {
    this.counts.lookups++;
    const trimmed = term.trim().slice(0, MAX_LOOKUP_TERM_LENGTH);
    if (trimmed && this.lookupTerms.length < MAX_LOOKUP_TERMS) this.lookupTerms.push(trimmed);
  }

  noteGotIt(now: number): void {
    this.counts.gotIts++;
    if (this.firstGotItMs === undefined) this.firstGotItMs = whole(this.visibleMs(now));
  }

  /** Whether the exposure is worth keeping: long enough to have been read, or something was done in it. */
  worthKeeping(now: number): boolean {
    if (this.visibleMs(now) >= MIN_KEPT_VISIBLE_MS || this.learnLater !== this.start.learnLater) return true;
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
      startedAt: Math.round(this.startedAt),
      endedAt: Math.max(Math.round(this.startedAt), Math.round(now)),
      final,
      visibleMs,
      analysisMs: Math.min(visibleMs, whole(this.analysisMs(now))),
      ...this.counts,
      lookupTerms: [...this.lookupTerms],
      ...(this.firstGotItMs !== undefined ? { firstGotItMs: this.firstGotItMs } : {}),
      learnLater: this.learnLater,
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

/** How the lesson left one sentence for another: by its place in the run, or auto-play's move. */
export function exitBetween(fromPosition: number, toPosition: number | null, autoPlaying: boolean): StudyExit {
  if (toPosition === null || toPosition === fromPosition) return 'other';
  if (autoPlaying) return 'auto';
  return toPosition > fromPosition ? 'next' : 'prev';
}
