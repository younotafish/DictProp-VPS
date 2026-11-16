import assert from 'node:assert/strict';
import test from 'node:test';
import { canRecordVoice, voiceStartErrorMessage } from '../../views/notebook/useVoiceSearch.ts';

const DENIED = 'Microphone access denied. Please enable microphone permissions.';
const UNSUPPORTED = "Voice search isn't available in this browser.";
const NO_MICROPHONE = "Couldn't start the microphone. Check that one is connected and not in use by another app.";

const failure = (name: string) => new DOMException('', name);

test('a refused microphone is told to allow it', () => {
  for (const name of ['NotAllowedError', 'SecurityError', 'PermissionDeniedError']) {
    assert.equal(voiceStartErrorMessage(failure(name)), DENIED, name);
  }
});

test("a recorder the browser can't run is the browser's limit", () => {
  assert.equal(voiceStartErrorMessage(failure('NotSupportedError')), UNSUPPORTED);
});

test('any other failure to start points at the microphone, not the browser', () => {
  // No input device, one another app holds or that fails, an aborted start, older Chrome's names for the first
  // two, a recorder started on a track that had ended, and errors that aren't the browser's at all.
  const failures = [
    failure('NotFoundError'), failure('NotReadableError'), failure('AbortError'),
    failure('DevicesNotFoundError'), failure('TrackStartError'), failure('InvalidStateError'),
    new TypeError('boom'), 'boom', undefined, null,
  ];
  for (const err of failures) assert.equal(voiceStartErrorMessage(err), NO_MICROPHONE, String(err));
});

test('a browser can record only with both microphone access and a recorder', () => {
  const withBrowser = (mediaDevices: object | undefined, recorder: unknown, run: () => void) => {
    const saved = ['navigator', 'MediaRecorder'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices }, configurable: true });
    Object.defineProperty(globalThis, 'MediaRecorder', { value: recorder, configurable: true });
    try {
      run();
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  };
  const microphone = { getUserMedia: async () => ({}) };
  class Recorder {}

  withBrowser(microphone, Recorder, () => assert.equal(canRecordVoice(), true));
  // An insecure page or an old browser has no mediaDevices; a browser without MediaRecorder can't record.
  withBrowser(undefined, Recorder, () => assert.equal(canRecordVoice(), false));
  withBrowser({}, Recorder, () => assert.equal(canRecordVoice(), false));
  withBrowser(microphone, undefined, () => assert.equal(canRecordVoice(), false));
});
