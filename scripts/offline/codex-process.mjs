import { spawn } from 'node:child_process';

// Process helpers for the model CLIs, Claude Code and Codex alike; the module is named for Codex, its first
// user. Each CLI runs in a process group of its own, so a signal reaches its helpers only through these.
export const DETACHED_PROCESS_GROUPS = process.platform !== 'win32';

export function spawnCodex(args) {
  return spawn(process.env.CODEX_BIN || '/usr/local/bin/codex', args, {
    stdio: ['pipe', 'ignore', 'pipe'],
    detached: DETACHED_PROCESS_GROUPS,
  });
}

export function killProcessGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (DETACHED_PROCESS_GROUPS) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    // macOS can report EPERM for a detached group while its leader is already
    // exiting. Fall back to the direct child instead of letting cleanup crash.
    if (DETACHED_PROCESS_GROUPS && error?.code === 'EPERM') {
      try {
        child.kill(signal);
      } catch (childError) {
        if (childError?.code !== 'ESRCH' && childError?.code !== 'EPERM') throw childError;
      }
      return;
    }
    throw error;
  }
}

// On SIGHUP, SIGINT or SIGTERM, stops every child's process group and exits; a second signal stops them at
// once. Children still running when the process exits any other way are killed as well: in process groups of
// their own, they would otherwise outlive it.
export function installSignalCleanup(activeChildren, onSignal = () => {}) {
  let handlingSignal = false;
  const exitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  const handlers = new Map();

  for (const signal of Object.keys(exitCodes)) {
    const handler = () => {
      if (handlingSignal) {
        for (const child of activeChildren) killProcessGroup(child, 'SIGKILL');
        process.exit(exitCodes[signal]);
      }
      handlingSignal = true;
      onSignal(signal);
      for (const child of activeChildren) killProcessGroup(child, 'SIGTERM');
      setTimeout(() => {
        for (const child of activeChildren) killProcessGroup(child, 'SIGKILL');
        process.exit(exitCodes[signal]);
      }, 2_000);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const killRemaining = () => {
    for (const child of activeChildren) killProcessGroup(child, 'SIGKILL');
  };
  process.on('exit', killRemaining);

  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.off('exit', killRemaining);
  };
}
