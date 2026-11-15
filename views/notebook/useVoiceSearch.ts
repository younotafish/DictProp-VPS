import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudio } from '../../services/api';
import { error as logError } from '../../services/logger';

/**
 * The search bar's microphone: records until tapped again, transcribes the recording, and hands the text to
 * `onTranscript`. Failures go to `reportError`, which a new transcription clears.
 */
export function useVoiceSearch(
  isOnline: boolean,
  onTranscript: (text: string) => void,
  reportError: (message: string | null) => void,
) {
  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // Clean up MediaRecorder and release microphone on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Voice recording functions
  const startRecording = useCallback(async () => {
    if (!isOnline) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Try to use audio/webm with opus codec, fallback to default
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;

        if (audioChunksRef.current.length === 0) return;

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];

        // Transcribe the audio
        setIsTranscribing(true);
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
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      logError('Failed to start recording:', err);
      reportError('Microphone access denied. Please enable microphone permissions.');
    }
  }, [isOnline, onTranscript, reportError]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  return { isRecording, isTranscribing, toggleRecording };
}
