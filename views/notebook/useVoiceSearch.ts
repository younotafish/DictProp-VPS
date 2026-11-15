import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudio } from '../../services/api';
import { error as logError } from '../../services/logger';

/** Where voice search is: waiting for the microphone, recording, or transcribing what it recorded. */
export type VoiceSearchState = 'idle' | 'starting' | 'recording' | 'transcribing';

// The formats to record in, best first. A browser that supports none of them records in its own default.
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

// The microphone was refused, by the user or the site's settings ('PermissionDeniedError' is older browsers' name).
const isPermissionError = (err: unknown): boolean => {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
};

/**
 * The search bar's microphone: records until tapped again, transcribes the recording, and hands the text to
 * `onTranscript`. Failures go to `reportError`, which a new transcription clears. A tap while the microphone is
 * starting or a recording is being transcribed does nothing. Hiding the tab stops a recording, which is still
 * transcribed, and releases the microphone.
 */
export function useVoiceSearch(
  isOnline: boolean,
  onTranscript: (text: string) => void,
  reportError: (message: string | null) => void,
) {
  const [state, setState] = useState<VoiceSearchState>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  // False while the tab is hidden or the notebook is gone, so a microphone granted meanwhile isn't kept.
  const activeRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      mediaStreamRef.current?.getTracks().forEach(track => track.stop());
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
    };
  }, []);

  const startRecording = useCallback(async () => {
    if (!isOnline) return;
    setState('starting');

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!activeRef.current) {
        stream.getTracks().forEach(track => track.stop());
        setState('idle');
        return;
      }
      mediaStreamRef.current = stream;

      const mimeType = RECORDING_TYPES.find(type => MediaRecorder.isTypeSupported(type));
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      const recordedStream = stream;
      mediaRecorder.onstop = async () => {
        // Stop all tracks to release microphone
        recordedStream.getTracks().forEach(track => track.stop());
        if (mediaStreamRef.current === recordedStream) mediaStreamRef.current = null;
        if (mediaRecorderRef.current === mediaRecorder) mediaRecorderRef.current = null;

        if (audioChunksRef.current.length === 0) {
          setState('idle');
          return;
        }

        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || mimeType });
        audioChunksRef.current = [];

        // Transcribe the audio
        setState('transcribing');
        reportError(null);

        try {
          const transcribedText = await transcribeAudio(audioBlob);
          if (transcribedText.trim()) {
            // Auto-search after transcription
            onTranscript(transcribedText.trim());
          }
        } catch (err) {
          logError('Transcription failed:', err);
          reportError((err as Error).message === 'QUOTA_EXCEEDED'
            ? 'Voice transcription quota exceeded. Please type your search.'
            : 'Voice transcription failed. Please try again.');
        } finally {
          setState('idle');
        }
      };

      mediaRecorder.start();
      setState('recording');
    } catch (err) {
      logError('Failed to start recording:', err);
      stream?.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
      setState('idle');
      reportError(isPermissionError(err)
        ? 'Microphone access denied. Please enable microphone permissions.'
        : "Voice search isn't available in this browser.");
    }
  }, [isOnline, onTranscript, reportError]);

  // The recorder's stop event ends the recording: it releases the microphone and moves on to transcribing.
  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);

  const toggleRecording = useCallback(() => {
    if (state === 'recording') stopRecording();
    else if (state === 'idle') startRecording();
  }, [state, startRecording, stopRecording]);

  return { state, toggleRecording };
}
