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
