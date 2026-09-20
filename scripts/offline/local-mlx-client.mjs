import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { killCodex } from './codex-process.mjs';

export const DEFAULT_LOCAL_MLX_VLM_PYTHON = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'dictprop',
  'local-vlm',
  'bin',
  'python',
);

export const DEFAULT_LOCAL_MLX_VLM_MODEL = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'dictprop',
  'local-ai',
  'models',
  'Qwen3-VL-8B-Instruct-4bit',
);

export function extractJsonObject(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Local model did not return a JSON object');
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Repair only missing terminal delimiters after a complete final value.
      const stack = [];
      let quoted = false;
      let escaped = false;
      let structurallyValid = true;
      for (const character of candidate) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{' || character === '[') stack.push(character);
        else if (character === '}' || character === ']') {
          const expected = character === '}' ? '{' : '[';
          if (stack.pop() !== expected) structurallyValid = false;
        }
      }
      if (!structurallyValid || quoted || stack.length === 0) {
        throw new Error('Local model returned malformed JSON');
      }
      const suffix = stack.reverse().map(character => character === '{' ? '}' : ']').join('');
      return JSON.parse(`${candidate}${suffix}`);
    }
  }
}

export function createLocalMlxClient({
  python = process.env.LOCAL_MLX_VLM_PYTHON || DEFAULT_LOCAL_MLX_VLM_PYTHON,
  model = process.env.LOCAL_MLX_VLM_MODEL || DEFAULT_LOCAL_MLX_VLM_MODEL,
  worker = process.env.LOCAL_MLX_VLM_WORKER || resolve('scripts/offline/local-mlx-vlm-worker.py'),
  timeoutMs = 40 * 60 * 1_000,
  activeChildren,
} = {}) {
  if (!existsSync(python)) throw new Error(`Local MLX Python is missing: ${python}`);
  if (!existsSync(model)) throw new Error(`Local MLX model is missing: ${model}`);
  if (!existsSync(worker)) throw new Error(`Local MLX worker is missing: ${worker}`);

  const child = spawn(python, [worker, '--model', model], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      TOKENIZERS_PARALLELISM: 'false',
    },
  });
  activeChildren?.add(child);

  let buffer = '';
  let stderr = '';
  let nextId = 1;
  let exited = false;
  let readyResolve;
  let readyReject;
  const pending = new Map();
  const ready = new Promise((resolvePromise, reject) => {
    readyResolve = resolvePromise;
    readyReject = reject;
  });

  const fail = error => {
    readyReject(error);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  child.stderr.on('data', chunk => {
    const output = String(chunk);
    stderr = `${stderr}${output}`.slice(-20_000);
    process.stderr.write(output);
  });
  child.stdout.on('data', chunk => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write(`[local-mlx] ${line}\n`);
        continue;
      }
      if (message.type === 'ready') {
        readyResolve(message);
        continue;
      }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.type === 'result' && typeof message.text === 'string') request.resolve(message.text);
      else request.reject(new Error(message.error || 'Local MLX generation failed'));
    }
  });
  child.on('error', error => fail(error));
  child.on('exit', (code, signal) => {
    exited = true;
    activeChildren?.delete(child);
    if (code !== 0 || pending.size > 0) {
      fail(new Error(`Local MLX worker exited with ${code ?? signal}: ${stderr}`));
    }
  });

  const startupTimeout = setTimeout(() => {
    const error = new Error(`Local MLX model did not load within ${Math.round(timeoutMs / 60_000)} minutes`);
    fail(error);
    killCodex(child, 'SIGTERM');
  }, timeoutMs);
  ready.finally(() => clearTimeout(startupTimeout)).catch(() => {});

  return {
    model,
    child,
    async generate(prompt, { maxTokens = 8192, temperature = 0, images } = {}) {
      await ready;
      if (exited) throw new Error('Local MLX worker is no longer running');
      const id = nextId++;
      return new Promise((resolvePromise, reject) => {
        const requestTimeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Local MLX request ${id} timed out`));
          killCodex(child, 'SIGTERM');
        }, timeoutMs);
        pending.set(id, { resolve: resolvePromise, reject, timeout: requestTimeout });
        child.stdin.write(`${JSON.stringify({ id, prompt, maxTokens, temperature, ...(images ? { images } : {}) })}\n`, error => {
          if (!error) return;
          clearTimeout(requestTimeout);
          pending.delete(id);
          reject(error);
        });
      });
    },
    async close() {
      if (exited) return;
      child.stdin.end();
      await new Promise(resolvePromise => {
        const timeout = setTimeout(() => {
          killCodex(child, 'SIGTERM');
          resolvePromise();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolvePromise();
        });
      });
    },
  };
}
