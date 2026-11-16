// Stand-ins for the browser media the speech engine drives (HTMLAudioElement, speechSynthesis, the server's TTS
// routes), so node tests can play through it without a browser. Install them before importing the engine: the
// system-voice module resolves its voice when it loads.

/** The parts of HTMLAudioElement the engine uses, with controls for the media events a test drives. */
export class FakeAudioElement {
  static created: FakeAudioElement[] = [];
  /** How play() answers: 'allow' starts playback, 'refuse' rejects it the way a blocked autoplay does. */
  static playPolicy: 'allow' | 'refuse' = 'allow';

  private source = '';
  private pendingPlays: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  readyState = 0;
  loop = false;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  playCalls = 0;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  onpause: (() => void) | null = null;

  constructor(src?: string) {
    if (src) this.source = src;
    FakeAudioElement.created.push(this);
  }

  get src(): string { return this.source; }
  set src(value: string) {
    // The media load algorithm: pending play() promises reject and the old media is forgotten.
    this.rejectPendingPlays();
    this.source = value;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.readyState = 0;
  }

  play(): Promise<void> {
    this.playCalls++;
    if (FakeAudioElement.playPolicy === 'refuse') return Promise.reject(new DOMException('play() was blocked', 'NotAllowedError'));
    this.paused = false;
    this.ended = false;
    return new Promise((resolve, reject) => {
      this.pendingPlays.push({ resolve, reject });
      queueMicrotask(() => {
        if (this.paused) return;
        const settled = this.pendingPlays;
        this.pendingPlays = [];
        for (const play of settled) play.resolve();
      });
    });
  }

  pause(): void {
    this.paused = true;
    this.rejectPendingPlays();
  }

  /** The media's metadata arrived. */
  loadMetadata(duration: number): void {
    this.duration = duration;
    this.readyState = 1;
    this.onloadedmetadata?.();
  }

  /** Playback actually started ('playing'). */
  startPlaying(): void { this.onplaying?.(); }

  /** Playback reached the end ('ended'). */
  finish(): void {
    if (Number.isFinite(this.duration)) this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.onended?.();
  }

  /** A media error ('error'). */
  fail(): void { this.onerror?.(); }

  /** The browser or the OS pauses the element (a call, AirPods taken out): 'pause', as no call of pause() made it. */
  externalPause(): void {
    this.paused = true;
    this.rejectPendingPlays();
    this.onpause?.();
  }

  private rejectPendingPlays(): void {
    const rejected = this.pendingPlays;
    this.pendingPlays = [];
    for (const play of rejected) play.reject(new DOMException('The play() request was interrupted', 'AbortError'));
  }
}

export class FakeUtterance {
  lang = '';
  rate = 1;
  volume = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(readonly text: string) {}
}

/** The parts of speechSynthesis the engine uses; a test fires the utterance's events itself. */
export class FakeSpeechSynthesis {
  spoken: FakeUtterance[] = [];
  calls: string[] = [];
  paused = false;
  speaking = false;
  getVoices() { return [{ name: 'Samantha', lang: 'en-US', localService: true }]; }
  addEventListener() {}
  removeEventListener() {}
  speak(utterance: FakeUtterance) { this.calls.push('speak'); this.spoken.push(utterance); this.speaking = true; }
  cancel() { this.calls.push('cancel'); this.speaking = false; }
  pause() { this.calls.push('pause'); this.paused = true; }
  resume() { this.calls.push('resume'); this.paused = false; }
  get last(): FakeUtterance | undefined { return this.spoken.at(-1); }
}

/** An AudioBufferSourceNode that records how it was scheduled; a test fires its 'ended' itself. */
export class FakeBufferSource {
  buffer: { length: number } | null = null;
  loop = false;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  connect<T>(node: T): T { return node; }
  start(when = 0) { this.startedAt = when; }
  stop(when = 0) {
    if (this.startedAt === null) throw new DOMException('stop() before start()', 'InvalidStateError');
    this.stoppedAt = when;
  }
}

/** The parts of AudioContext the keep-alive uses. It starts suspended, as one created outside a gesture does. */
export class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  state: AudioContextState = 'suspended';
  currentTime = 0;
  readonly sampleRate = 48_000;
  readonly destination = {};
  readonly sources: FakeBufferSource[] = [];
  oscillatorsStarted = 0;
  constructor() { FakeAudioContext.created.push(this); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  createOscillator() {
    return { frequency: { value: 0 }, connect: <T>(node: T) => node, start: () => { this.oscillatorsStarted++; } };
  }
  createGain() { return { gain: { value: 1 }, connect: <T>(node: T) => node }; }
  createBuffer(_channels: number, length: number) { return { length }; }
  createBufferSource() {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
}

export interface FakeMedia {
  synth: FakeSpeechSynthesis;
  /** The shared <audio> element the engine plays clips through (the first element it created after install). */
  element: () => FakeAudioElement;
}

/** Install the fakes as the browser globals the engine reads. `speech: false` leaves the page without a speech engine. */
export const installFakeMedia = (options: { speech?: boolean; userAgent?: string } = {}): FakeMedia => {
  const synth = new FakeSpeechSynthesis();
  const firstCreated = FakeAudioElement.created.length;
  Object.assign(globalThis, {
    Audio: FakeAudioElement,
    SpeechSynthesisUtterance: FakeUtterance,
    window: { speechSynthesis: options.speech === false ? undefined : synth, confirm: () => false, AudioContext: FakeAudioContext },
  });
  if (options.userAgent) {
    Object.defineProperty(globalThis.navigator, 'userAgent', { configurable: true, value: options.userAgent });
  }
  return {
    synth,
    element: () => {
      const element = FakeAudioElement.created[firstCreated];
      if (!element) throw new Error('the engine has not created its <audio> element yet');
      return element;
    },
  };
};

/** navigator.mediaSession as the engine drives it: the state the lock screen shows and the actions it offers. */
export class FakeMediaSession {
  playbackState: MediaSessionPlaybackState = 'none';
  metadata: unknown = null;
  readonly handlers = new Map<string, () => void>();
  setActionHandler(action: string, handler: (() => void) | null): void {
    if (handler) this.handlers.set(action, handler);
    else this.handlers.delete(action);
  }
  /** The lock screen or a headset presses `action`. */
  press(action: string): void { this.handlers.get(action)?.(); }
}

/** Install a fake navigator.mediaSession (and MediaMetadata) and return it. */
export const installFakeMediaSession = (): FakeMediaSession => {
  const session = new FakeMediaSession();
  Object.defineProperty(globalThis.navigator, 'mediaSession', { configurable: true, value: session });
  Object.assign(globalThis, { MediaMetadata: class { constructor(readonly init: unknown) {} } });
  return session;
};

export const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

interface Timing { text: string; start: number; end: number }

/** The server's TTS routes: cached clips and timings by key, and the generation requests it receives. */
export class FakeTtsServer {
  readonly clips = new Map<string, Blob>();
  readonly timings = new Map<string, Timing[]>();
  readonly generated: Array<{ text: string; voice?: string }> = [];
  readonly requests: string[] = [];
  /** Awaited before a clip or timings request is answered, so a test can hold requests in flight. */
  latency: (() => Promise<void>) | null = null;
  /** Runs when a generation request arrives, before it's answered (to add the clips it makes, say). */
  onGenerate: ((items: Array<{ text: string; voice?: string }>) => Promise<void> | void) | null = null;
  inFlight = 0;
  maxInFlight = 0;

  install(): void {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      this.requests.push(url);
      const clip = url.match(/\/api\/tts\/([0-9a-f]{64})\.mp3$/);
      const timings = url.match(/\/api\/tts\/([0-9a-f]{64})\/timings$/);
      if (clip || timings) {
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          await this.latency?.();
          if (clip) {
            const blob = this.clips.get(clip[1]);
            return blob ? new Response(blob) : new Response('Not found', { status: 404 });
          }
          const found = this.timings.get(timings![1]);
          return found ? Response.json(found) : new Response('Not found', { status: 404 });
        } finally {
          this.inFlight--;
        }
      }
      if (url.endsWith('/api/tts/generate')) {
        const items = (JSON.parse(String(init?.body)) as { items: Array<{ text: string; voice?: string }> }).items;
        this.generated.push(...items);
        await this.onGenerate?.(items);
        return Response.json({ generated: items.length, skipped: 0, failed: 0 });
      }
      return new Response('Unexpected request', { status: 500 });
    };
  }
}

/** Let queued promise callbacks and tasks run until `check` holds, failing after five seconds. */
export const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = performance.now() + 5000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
};
