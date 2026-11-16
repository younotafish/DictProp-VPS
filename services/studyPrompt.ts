/**
 * What a study prompt shows. Pure text work, so the study session (services/studySession.ts) and the card
 * (components/study/StudyCard.tsx) share one version of it.
 */

import { stripSentenceMarkers } from './sentenceMarkers';

/** The sentence with the studied word blanked out: its {{marked}} form when there is one, else the word itself. */
export function createClozePrompt(sentence: string, word: string): string {
  const markedCloze = (sentence || '').replace(/\{\{(.+?)\}\}/g, '_____');
  const plain = stripSentenceMarkers(markedCloze);
  if (plain.includes('_____')) return plain;
  if (!word.trim()) return plain;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return plain.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '_____');
}
