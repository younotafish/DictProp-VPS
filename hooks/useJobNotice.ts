import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobNotice } from '../services/jobNotices';

/**
 * The background jobs' result pill (services/jobNotices): one slot, so a new result replaces the one showing, with its
 * own timer, which a result that stays until dismissed doesn't start.
 */
export function useJobNotice() {
  const [jobNotice, setJobNotice] = useState<JobNotice | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const showJobNotice = useCallback((notice: JobNotice) => {
    window.clearTimeout(timerRef.current);
    setJobNotice(notice);
    timerRef.current = notice.timeoutMs === null ? undefined : window.setTimeout(() => setJobNotice(null), notice.timeoutMs);
  }, []);

  const dismissJobNotice = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setJobNotice(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return { jobNotice, showJobNotice, dismissJobNotice };
}

export type JobNotices = ReturnType<typeof useJobNotice>;
