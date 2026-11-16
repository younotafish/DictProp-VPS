/**
 * Where this device keeps the study session in progress, so a reload brings it back: one localStorage entry holding
 * only card ids and grades (services/studySessionRecord.ts makes and reads it). Signing out clears it from
 * services/auth.ts, which puts this module in the app's first chunk, so it holds no more than the key and the three
 * storage calls.
 */
export const STUDY_SESSION_KEY = 'study_session_v2';

export function readStoredStudySession(): string | null {
  try {
    return localStorage.getItem(STUDY_SESSION_KEY);
  } catch {
    return null; // storage unavailable
  }
}

export function writeStoredStudySession(record: string): void {
  try {
    localStorage.setItem(STUDY_SESSION_KEY, record);
  } catch {
    /* storage full or unavailable: the session just won't survive a reload */
  }
}

export function clearStoredStudySession(): void {
  try {
    localStorage.removeItem(STUDY_SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}
