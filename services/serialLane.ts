/** Runs the tasks handed to it one at a time, each after the one before has settled. */
export type SerialLane = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A lane that runs tasks one at a time, in the order they were handed to it. A task that fails, or throws
 * before returning its promise, rejects only its own promise: the next task still runs.
 */
export function createSerialLane(): SerialLane {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
