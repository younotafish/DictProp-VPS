import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-file.mjs';
import { DETACHED_PROCESS_GROUPS, killProcessGroup } from './codex-process.mjs';

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

// A model call that failed before giving an answer to check: kind is 'timeout' when it ran out of time,
// 'exit' when the CLI exited with an error, and 'spawn' when it could not be started. Its message carries what
// the CLI said about the failure, never its raw output, which can hold a whole response envelope.
export class ModelCallError extends Error {
  constructor(kind, message, options) {
    super(message, options);
    this.name = 'ModelCallError';
    this.kind = kind;
  }
}

function formatDuration(milliseconds) {
  return milliseconds >= 60_000
    ? `${Number((milliseconds / 60_000).toFixed(1))} min`
    : `${Number((milliseconds / 1_000).toFixed(1))} s`;
}

// The text of the last Claude result envelope on stdout, else the end of stderr.
function failureSummary(output, stderr) {
  const envelopeText = String(lastResultEnvelope(output)?.result ?? '').trim().slice(0, 2_000);
  return envelopeText || stderr.trim().slice(-2_000);
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
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM');
      hardKillTimeout = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 10_000);
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
      if (exit.code === 0) {
        settle(null, output);
      } else if (timedOut) {
        settle(new ModelCallError('timeout', `${label} did not answer within ${formatDuration(timeoutMs)}`));
      } else {
        const summary = failureSummary(output, stderr);
        settle(new ModelCallError('exit', `${label} exited with ${exit.code ?? exit.signal}${summary ? `: ${summary}` : ''}`));
      }
    };
    child.stdout?.on('data', chunk => stdout.push(chunk));
    child.stdout?.on('end', () => {
      stdoutEnded = true;
      finish();
    });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-30_000); });
    child.on('error', error => settle(new ModelCallError('spawn', `${label} could not start: ${error.message}`, { cause: error })));
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

function lastResultEnvelope(output) {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].startsWith('{')) continue;
    try {
      const message = JSON.parse(lines[index]);
      if (message?.type === 'result') return message;
    } catch {
      // Launcher banners and partial lines are not result messages.
    }
  }
  return undefined;
}

export function claudeStructuredResult(output) {
  const envelope = lastResultEnvelope(output) ?? parseJsonText(output, 'Claude');
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
    writeJsonAtomic(resultPath, result);
    return result;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function runCodex(config, { prompt, schema, resultPath, images, timeoutMs, activeChildren }) {
  // Codex reads its output schema from a file, which lives only as long as the call.
  const schemaDir = mkdtempSync(join(tmpdir(), 'dictprop-codex-'));
  const schemaPath = join(schemaDir, 'schema.json');
  try {
    writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });
    await runModelProcess(process.env.CODEX_BIN || '/usr/local/bin/codex', [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
      '-m', config.model, '-c', `model_reasoning_effort="${config.reasoningEffort}"`,
      ...images.flatMap(path => ['-i', path]),
      '--output-schema', schemaPath, '-o', resultPath, '-',
    ], { input: prompt, timeoutMs, activeChildren, label: 'Codex' });
  } finally {
    rmSync(schemaDir, { recursive: true, force: true });
  }
  return JSON.parse(readFileSync(resultPath, 'utf8'));
}

// Asks the configured model for one JSON object matching the schema. The result is written to resultPath,
// which callers keep as their cache, and returned.
export function runStructuredModel(config, request) {
  const { prompt, schema, resultPath, timeoutMs, activeChildren } = request;
  const call = { prompt, schema, resultPath, images: request.images || [], timeoutMs, activeChildren };
  return config.provider === 'claude' ? runClaude(config, call) : runCodex(config, call);
}

const READINESS_ICON = fileURLToPath(new URL('../../public/pwa-192x192.png', import.meta.url));
const READINESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
};

// One small image-bearing call proves authentication, model access, schemas, and vision input. Resolves when
// the model answered as asked; throws otherwise.
export async function checkModelReady(config, { timeoutMs = 5 * 60 * 1_000, activeChildren } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'dictprop-model-check-'));
  try {
    const result = await runStructuredModel({ ...config, reasoningEffort: 'low' }, {
      prompt: 'This is an automated readiness check. If you can see the attached app icon, return {"ok": true}.',
      schema: READINESS_SCHEMA,
      resultPath: join(workDir, 'result.json'),
      images: [READINESS_ICON],
      timeoutMs,
      activeChildren,
    });
    if (result?.ok !== true) throw new Error(`unexpected response ${JSON.stringify(result)}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
