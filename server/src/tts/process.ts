// Running ffmpeg and whisper-cli: one child process at a time per call, with a time limit, settling only once its
// output streams have closed so no stderr is lost from an error message.
import { spawn } from 'node:child_process';

/** How a child process failed: it couldn't start, it exited unsuccessfully, or it ran past its time limit. */
export type ProcessFailure = 'spawn' | 'exit' | 'timeout';

export class ProcessError extends Error {
  readonly reason: ProcessFailure;
  /** The tail of what the process wrote to stderr. */
  readonly stderr: string;

  constructor(reason: ProcessFailure, message: string, stderr: string) {
    super(message);
    this.name = 'ProcessError';
    this.reason = reason;
    this.stderr = stderr;
  }
}

export interface RunOptions {
  /** Written to stdin, which is otherwise closed. */
  input?: Buffer;
  timeoutMs: number;
  /** Collect stdout; otherwise it is discarded. */
  captureStdout?: boolean;
}

export interface RunResult {
  /** Empty unless captured. */
  stdout: Buffer;
  stderr: string;
}

// Enough stderr to explain a failure; a chatty process can't grow it without bound.
const STDERR_TAIL_CHARS = 20_000;

/** Runs a command to completion. Rejects with a ProcessError when it fails to start, exits non-zero or times out. */
export function runProcess(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: [options.input ? 'pipe' : 'ignore', options.captureStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const finish = (error?: ProcessError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolvePromise({ stdout: Buffer.concat(stdout), stderr });
    };
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS); });
    child.on('error', error => finish(new ProcessError('spawn', error.message, stderr)));
    child.on('close', (code, signal) => {
      if (code === 0) finish();
      else finish(new ProcessError('exit', `${command} exited with ${code ?? signal}: ${stderr.slice(-2_000)}`, stderr));
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new ProcessError('timeout', `${command} exceeded ${options.timeoutMs}ms`, stderr));
    }, options.timeoutMs);
    if (options.input && child.stdin) {
      child.stdin.on('error', () => {}); // swallow EPIPE if the process exits before reading everything
      child.stdin.end(options.input);
    }
  });
}
