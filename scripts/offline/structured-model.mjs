import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { killCodex } from './codex-process.mjs';

const DETACHED_PROCESS_GROUPS = process.platform !== 'win32';
const IMAGE_MEDIA_TYPES = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function resolveStructuredModel(env = process.env) {
  const provider = String(env.ENRICHMENT_MODEL_PROVIDER || 'claude').trim().toLowerCase();
  if (provider === 'claude') {
    return {
      provider,
      marker: 'claude-code',
      label: 'Claude Code',
      cacheKey: 'claude-code-v1',
      model: env.CLAUDE_MODEL || 'claude-opus-5-5',
      reasoningEffort: env.CLAUDE_REASONING_EFFORT || 'xhigh',
    };
  }
  if (provider === 'codex') {
    return {
      provider,
      marker: 'codex-harness',
      label: 'Codex harness',
      cacheKey: 'codex-cli-v2',
      model: env.CODEX_MODEL || 'gpt-5.6-sol',
      reasoningEffort: env.CODEX_REASONING_EFFORT || 'xhigh',
    };
  }
  throw new Error(`ENRICHMENT_MODEL_PROVIDER must be "claude" or "codex", not "${provider}"`);
}

function runModelProcess(command, args, {
  input, timeoutMs, activeChildren, captureStdout = false, cwd, env = process.env, label,
}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', captureStdout ? 'pipe' : 'ignore', 'pipe'],
      detached: DETACHED_PROCESS_GROUPS,
    });
    activeChildren?.add(child);
    const stdout = [];
    let stderr = '';
    let exit;
    let stdoutEnded = !captureStdout;
    let settled = false;
    let hardKillTimeout;
    let drainTimeout;
    const timeout = setTimeout(() => {
      killCodex(child, 'SIGTERM');
      hardKillTimeout = setTimeout(() => killCodex(child, 'SIGKILL'), 10_000);
    }, timeoutMs);
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      activeChildren?.delete(child);
      clearTimeout(timeout);
      clearTimeout(hardKillTimeout);
      clearTimeout(drainTimeout);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const finish = () => {
      if (!exit || !stdoutEnded) return;
      const output = Buffer.concat(stdout).toString('utf8');
      if (exit.code === 0) settle(null, output);
      else settle(new Error(`${label} exited with ${exit.code ?? exit.signal}: ${stderr}${output.slice(-10_000)}`));
    };
    child.stdout?.on('data', chunk => stdout.push(chunk));
    child.stdout?.on('end', () => {
      stdoutEnded = true;
      finish();
    });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-30_000); });
    child.on('error', error => settle(error));
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // A helper process that inherited stdout must not hold a finished call open.
      drainTimeout = setTimeout(() => {
        stdoutEnded = true;
        finish();
      }, 5_000);
      finish();
    });
    // A CLI that fails during startup may close stdin before a large prompt is written.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function imageMediaType(path) {
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
  if (!mediaType) throw new Error(`Unsupported image attachment: ${path}`);
  return mediaType;
}

function parseJsonText(value, label) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} returned no JSON`);
  let text = value.trim();
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const object = text.match(/\{[\s\S]*\}/);
    if (!object) throw new Error(`${label} returned invalid JSON`);
    return JSON.parse(object[0]);
  }
}

export function claudeStructuredResult(output) {
  let envelope;
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0 && !envelope; index--) {
    if (!lines[index].startsWith('{')) continue;
    try {
      const message = JSON.parse(lines[index]);
      if (message?.type === 'result') envelope = message;
    } catch {
      // Launcher banners and partial lines are not result messages.
    }
  }
  envelope ??= parseJsonText(output, 'Claude');
  if (envelope.is_error || (envelope.subtype && envelope.subtype !== 'success')) {
    throw new Error(`Claude failed (${envelope.subtype || 'error'}): ${String(envelope.result || '').slice(0, 2_000)}`);
  }
  if (envelope.structured_output && typeof envelope.structured_output === 'object') return envelope.structured_output;
  return parseJsonText(envelope.result, 'Claude structured output');
}

async function runClaude(config, { prompt, schema, resultPath, images, timeoutMs, activeChildren }) {
  // Image attachments require the stream-json input protocol; text prompts use the plain JSON result.
  const streaming = images.length > 0;
  const args = [
    '-p', '--model', config.model, '--effort', config.reasoningEffort,
    '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--json-schema', JSON.stringify(schema),
    ...(streaming
      ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
      : ['--output-format', 'json']),
  ];
  const input = streaming
    ? `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          ...images.flatMap((path, index) => [
            { type: 'text', text: `Attached image ${index + 1} of ${images.length}:` },
            {
              type: 'image',
              source: { type: 'base64', media_type: imageMediaType(path), data: readFileSync(path).toString('base64') },
            },
          ]),
          { type: 'text', text: prompt },
        ],
      },
      parent_tool_use_id: null,
      session_id: 'default',
    })}\n`
    : prompt;
  // An empty working directory keeps repository instructions and files out of the model context.
  const cwd = mkdtempSync(join(tmpdir(), 'dictprop-claude-'));
  try {
    const output = await runModelProcess(process.env.CLAUDE_BIN || '/usr/local/bin/claude', args, {
      input,
      timeoutMs,
      activeChildren,
      captureStdout: true,
      cwd,
      env: {
        ...process.env,
        // Claude Code lets this variable override --effort, so an inherited session value must not win.
        CLAUDE_CODE_EFFORT_LEVEL: config.reasoningEffort,
        // Claude Code restarts a stream after five silent minutes, and xhigh work on a large batch can stay
        // silent longer, so the restarted request never finishes. The request timeout already bounds the call.
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: String(timeoutMs),
      },
      label: 'Claude',
    });
    const result = claudeStructuredResult(output);
    const tempPath = `${resultPath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, resultPath);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export async function runStructuredModel(config, request) {
  const { prompt, schema, schemaPath, resultPath, timeoutMs, activeChildren } = request;
  const images = request.images || [];
  if (config.provider === 'claude') {
    await runClaude(config, { prompt, schema, resultPath, images, timeoutMs, activeChildren });
    return;
  }
  await runModelProcess(process.env.CODEX_BIN || '/usr/local/bin/codex', [
    'exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
    '-m', config.model, '-c', `model_reasoning_effort="${config.reasoningEffort}"`,
    ...images.flatMap(path => ['-i', path]),
    '--output-schema', schemaPath, '-o', resultPath, '-',
  ], { input: prompt, timeoutMs, activeChildren, label: 'Codex' });
}
