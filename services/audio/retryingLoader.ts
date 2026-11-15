/** A one-time asynchronous load (a dynamic import, say) that callers share while it runs. */
export interface RetryingLoader<T> {
  /** What the load produced, or null until one has succeeded. */
  readonly current: T | null;
  /** Load, or join the load under way. A failed load is forgotten, so the next call tries again. */
  load(): Promise<T>;
}

/** `onLoaded` runs once, when a load first succeeds, before anyone waiting on it continues. */
export const retryingLoader = <T>(importer: () => Promise<T>, onLoaded: (value: T) => void = () => {}): RetryingLoader<T> => {
  let current: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    get current() { return current; },
    load() {
      if (current) return Promise.resolve(current);
      pending ??= importer().then(
        value => { current = value; onLoaded(value); return value; },
        error => { pending = null; throw error; },
      );
      return pending;
    },
  };
};
