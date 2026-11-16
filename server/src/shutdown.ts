// How the server process ends: index.ts calls the shutdown it builds here on a signal or a fatal error.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/** How often a drain closes the kept-alive connections that have gone idle. */
const IDLE_SWEEP_MS = 100;

/**
 * Stop `server` taking connections and call `done` once every open one has ended. server.close() ends only the
 * connections idle when it is called, and Caddy keeps its connections to the app open between requests, so one whose
 * request was in flight would stay open for keepAliveTimeout, past the deadline. During the drain a response tells
 * its client the connection closes after it, and a connection still kept alive is closed once it goes idle.
 */
export function drainHttpServer(server: Server, done: (error?: Error) => void, sweepMs = IDLE_SWEEP_MS): void {
  server.prependListener('request', (_request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Connection', 'close');
  });
  const sweep = setInterval(() => server.closeIdleConnections(), sweepMs);
  sweep.unref();
  server.close(error => {
    clearInterval(sweep);
    done(error);
  });
}

/**
 * Docker sends SIGKILL 3 s after SIGTERM (docker-compose.yml's stop_grace_period), so a drain still running at
 * this point ends here, with a log line, instead of silently under SIGKILL.
 */
export const SHUTDOWN_DEADLINE_MS = 2_500;

export interface ShutdownSteps {
  /** Stop taking connections; `done` runs once every open one has ended. */
  closeServer: (done: (error?: Error) => void) => void;
  closeDatabase: () => void;
  exit: (code: number) => void;
  deadlineMs?: number;
}

/**
 * The process's one shutdown: the requests in flight finish, the database closes and the process exits, or it
 * exits 1 if they are still running at the deadline. A second signal or a fatal error during the drain changes
 * nothing.
 */
export function createShutdown({ closeServer, closeDatabase, exit, deadlineMs = SHUTDOWN_DEADLINE_MS }: ShutdownSteps) {
  let shuttingDown = false;
  return (reason: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${reason}, closing HTTP server...`);
    const deadline = setTimeout(() => {
      console.error(`Requests were still running ${deadlineMs} ms into the shutdown; exiting without them.`);
      exit(1);
    }, deadlineMs);
    deadline.unref();
    closeServer((error) => {
      clearTimeout(deadline);
      if (error) {
        console.error('Failed to close HTTP server:', error);
        exitCode = 1;
      }
      // Nothing can run between this and the exit, so no request or job sees a closed database.
      try {
        closeDatabase();
      } catch (closeError) {
        console.error('Failed to close the database:', closeError);
        exitCode = 1;
      }
      exit(exitCode);
    });
  };
}
