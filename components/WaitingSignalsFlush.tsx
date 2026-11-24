import { useWaitingSignalsFlush } from '../hooks/useWaitingSignalsFlush';

/** Sends the study signals and Learn later changes a lesson left waiting (useWaitingSignalsFlush); renders nothing. */
export function WaitingSignalsFlush({ userId }: { userId: string }) {
  useWaitingSignalsFlush(userId);
  return null;
}
