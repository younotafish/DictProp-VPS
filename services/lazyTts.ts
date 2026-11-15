/**
 * The speech API the screens import. It loads the engine (services/neuralTts.ts) the first time it's needed and
 * forwards each call to it, so the screens' own chunks don't carry the engine. Once the engine has loaded, calls
 * reach it synchronously, inside the caller's tap and in the caller's order; before that they wait for the load,
 * playback reads as idle and keep-alive holds are counted here. A load that fails (offline right after an
 * update, before the new engine was cached) is tried again by the next call.
 */
import type { WordTiming } from './api';
import type { MediaSessionHandlers, PlaybackState, SpeakHandle, SpeakOptions } from './neuralTts';
import { retryingLoader } from './audio/retryingLoader';
export type { MediaSessionHandlers, PlaybackState, PlaybackStatus, SpeakHandle, SpeakOptions } from './neuralTts';

type Engine = typeof import('./neuralTts');
const playbackListeners = new Set<(state: PlaybackState) => void>();
let playbackState: PlaybackState = { status: 'idle', text: null };
// Holds taken before the engine loaded, handed to it once it has. A release in the meantime cancels one
// of them: dropping that release instead would leak the hold and keep the silent keep-alive running.
let holdsBeforeLoad = 0;

const engineLoader = retryingLoader<Engine>(() => import('./neuralTts'), module => {
  module.subscribePlayback(state => {
    playbackState = state;
    playbackListeners.forEach(listener => listener(state));
  });
  for (; holdsBeforeLoad > 0; holdsBeforeLoad--) module.acquireKeepAlive();
});
const loadEngine = () => engineLoader.load();
// Nothing to do when the engine couldn't load: the next call tries again.
const ignoreLoadFailure = () => {};

/** Run `call` on the engine: now if it's loaded, else once it loads. */
const withEngine = (call: (engine: Engine) => void): void => {
  const engine = engineLoader.current;
  if (engine) call(engine);
  else void loadEngine().then(call, ignoreLoadFailure);
};
/** Ask the engine for a result: now if it's loaded, else once it loads; `fallback` answers a failed load. */
const askEngine = <T>(call: (engine: Engine) => Promise<T>, fallback: () => T): Promise<T> => {
  const engine = engineLoader.current;
  return engine ? call(engine) : loadEngine().then(call, fallback);
};

function speak(method: 'speakNatural' | 'speakWord', text: string, options?: SpeakOptions): SpeakHandle {
  const engine = engineLoader.current;
  if (engine) return method === 'speakWord' ? engine.speakWord(text) : engine.speakNatural(text, options);
  // Until the engine loads, a handle that starts the speech once it does, unless stopped first.
  let handle: SpeakHandle | null = null;
  let cancelled = false;
  void loadEngine().then(module => {
    if (cancelled) return;
    handle = method === 'speakWord' ? module.speakWord(text) : module.speakNatural(text, options);
  }).catch(error => options?.onError?.(error));
  return {
    stop: () => { cancelled = true; handle?.stop(); },
    isActive: () => !cancelled && (handle?.isActive() ?? true),
  };
}

export const speakNatural = (text: string, options: SpeakOptions = {}) => speak('speakNatural', text, options);
export const speakWord = (text: string) => speak('speakWord', text);
export const getPlaybackState = () => engineLoader.current?.getPlaybackState() ?? playbackState;
export const subscribePlayback = (listener: (state: PlaybackState) => void) => {
  playbackListeners.add(listener); listener(getPlaybackState());
  return () => { playbackListeners.delete(listener); };
};
export const getPlaybackProgress = () => engineLoader.current?.getPlaybackProgress() ?? 0;
export const pauseCurrent = () => engineLoader.current?.pauseCurrent();
export const resumeCurrent = () => engineLoader.current?.resumeCurrent();
export const stopCurrent = () => engineLoader.current?.stopCurrent();
export const seekCurrent = (seconds: number) => engineLoader.current?.seekCurrent(seconds);
// A prime made while stopping auto-play runs within the tap, before the effect cleanup releases the last hold;
// were it deferred, it would restart the silent keep-alive after that release, with nothing left to stop it.
export const primeKeepAlive = () => withEngine(engine => engine.primeKeepAlive());
export const acquireKeepAlive = () => {
  const engine = engineLoader.current;
  if (engine) { engine.acquireKeepAlive(); return; }
  holdsBeforeLoad++;
  void loadEngine().catch(ignoreLoadFailure);
};
export const releaseKeepAlive = () => {
  if (holdsBeforeLoad > 0) holdsBeforeLoad--;
  else engineLoader.current?.releaseKeepAlive();
};
export const setMediaMetadata = (info: { title: string; artist?: string; album?: string; artworkUrl?: string }) =>
  withEngine(engine => engine.setMediaMetadata(info));
export const setMediaSessionHandlers = (handlers: MediaSessionHandlers | null) =>
  withEngine(engine => engine.setMediaSessionHandlers(handlers));
// The engine's timer also runs off the keep-alive's audio clock, which keeps going with the screen off
// or the tab hidden, where a plain timer stalls; it's loaded by the speech that comes before any gap.
export const afterGap = (ms: number, callback: () => void) => {
  const engine = engineLoader.current;
  if (engine) return engine.afterGap(ms, callback);
  const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
};
export const getTimingsFor = (text: string): Promise<WordTiming[] | null> => askEngine(engine => engine.getTimingsFor(text), () => null);
export const ensureTimings = (text: string): Promise<void> => askEngine(engine => engine.ensureTimings(text), ignoreLoadFailure);
export const prefetchTTS = (texts: string[]) => withEngine(engine => engine.prefetchTTS(texts));
export const ensureTTS = (texts: string[]): Promise<void> => askEngine(engine => engine.ensureTTS(texts), ignoreLoadFailure);
export const preloadAudio = (
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  options?: { intoMemory?: boolean; signal?: AbortSignal },
): Promise<void> => askEngine(engine => engine.preloadAudio(texts, onProgress, options), ignoreLoadFailure);
