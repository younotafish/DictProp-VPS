import type { WordTiming } from './api';

type Engine = typeof import('./neuralTts');
let engine: Engine | null = null;
let enginePromise: Promise<Engine> | null = null;
const playbackListeners = new Set<(state: PlaybackState) => void>();
let playbackState: PlaybackState = { status: 'idle', text: '' };

function loadEngine(): Promise<Engine> {
  if (engine) return Promise.resolve(engine);
  if (!enginePromise) {
    enginePromise = import('./neuralTts').then(module => {
      engine = module;
      module.subscribePlayback(state => {
        playbackState = state;
        playbackListeners.forEach(listener => listener(state));
      });
      return module;
    });
  }
  return enginePromise;
}

export interface SpeakHandle {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
  isActive: () => boolean;
}
export interface SpeakOptions {
  voice?: string; rate?: number; allowDownload?: boolean; startAt?: number;
  onStart?: () => void; onEnd?: () => void; onError?: (event: any) => void;
}
export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused';
export interface PlaybackState { status: PlaybackStatus; text: string }
export interface MediaSessionHandlers {
  onPlay?: () => void; onPause?: () => void; onStop?: () => void;
  onNext?: () => void; onPrev?: () => void;
}

function deferredSpeak(method: 'speakNatural' | 'speakWord', text: string, options?: SpeakOptions): SpeakHandle {
  let handle: SpeakHandle | null = null;
  let cancelled = false;
  void loadEngine().then(module => {
    if (cancelled) return;
    handle = method === 'speakWord' ? module.speakWord(text) : module.speakNatural(text, options);
  }).catch(error => options?.onError?.(error));
  return {
    stop: () => { cancelled = true; handle?.stop(); },
    pause: () => handle?.pause(), resume: () => handle?.resume(),
    isPaused: () => handle?.isPaused() ?? false,
    isActive: () => !cancelled && (handle?.isActive() ?? true),
  };
}

export const speakNatural = (text: string, options: SpeakOptions = {}) => deferredSpeak('speakNatural', text, options);
export const speakWord = (text: string) => deferredSpeak('speakWord', text);
export const preloadNeural = () => { void loadEngine().then(module => module.preloadNeural()); };
export const isNeuralSupported = () => typeof navigator !== 'undefined' && typeof WebAssembly !== 'undefined';
export const getPlaybackState = () => engine?.getPlaybackState() ?? playbackState;
export const subscribePlayback = (listener: (state: PlaybackState) => void) => {
  playbackListeners.add(listener); listener(getPlaybackState());
  return () => { playbackListeners.delete(listener); };
};
export const getPlaybackProgress = () => engine?.getPlaybackProgress() ?? 0;
export const pauseCurrent = () => engine?.pauseCurrent();
export const resumeCurrent = () => engine?.resumeCurrent();
export const stopCurrent = () => engine?.stopCurrent();
export const seekCurrent = (seconds: number) => engine?.seekCurrent(seconds);
export const primeKeepAlive = () => { void loadEngine().then(module => module.primeKeepAlive()); };
export const acquireKeepAlive = () => { void loadEngine().then(module => module.acquireKeepAlive()); };
export const releaseKeepAlive = () => engine?.releaseKeepAlive();
export const setMediaMetadata = (info: { title: string; artist?: string; album?: string; artworkUrl?: string }) => {
  void loadEngine().then(module => module.setMediaMetadata(info));
};
export const setMediaSessionHandlers = (handlers: MediaSessionHandlers | null) => {
  void loadEngine().then(module => module.setMediaSessionHandlers(handlers));
};
export const afterGap = (ms: number, callback: () => void) => {
  const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
};
export const getTimingsFor = (text: string): Promise<WordTiming[] | null> => loadEngine().then(module => module.getTimingsFor(text));
export const ensureTimings = (text: string): Promise<void> => loadEngine().then(module => module.ensureTimings(text));
export const prefetchTTS = (texts: string[]) => { void loadEngine().then(module => module.prefetchTTS(texts)); };
export const ensureTTS = (texts: string[]): Promise<void> => loadEngine().then(module => module.ensureTTS(texts));
export const preloadAudio = (texts: string[], onProgress?: (done: number, total: number) => void) =>
  loadEngine().then(module => module.preloadAudio(texts, onProgress));
