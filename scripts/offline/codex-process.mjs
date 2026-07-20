import { spawn } from 'node:child_process';

const DETACHED_PROCESS_GROUPS = process.platform !== 'win32';

export function spawnCodex(args) {
  return spawn('/usr/local/bin/codex', args, {
    stdio: ['pipe', 'ignore', 'pipe'],
    detached: DETACHED_PROCESS_GROUPS,
  });
}

export function killCodex(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (DETACHED_PROCESS_GROUPS) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export function installCodexSignalCleanup(activeChildren, onSignal = () => {}) {
  let handlingSignal = false;
  const exitCodes = { SIGINT: 130, SIGTERM: 143 };
  const handlers = new Map();

  for (const signal of Object.keys(exitCodes)) {
    const handler = () => {
      if (handlingSignal) {
        for (const child of activeChildren) killCodex(child, 'SIGKILL');
        process.exit(exitCodes[signal]);
      }
      handlingSignal = true;
      onSignal(signal);
      for (const child of activeChildren) killCodex(child, 'SIGTERM');
      setTimeout(() => {
        for (const child of activeChildren) killCodex(child, 'SIGKILL');
        process.exit(exitCodes[signal]);
      }, 2_000);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}
