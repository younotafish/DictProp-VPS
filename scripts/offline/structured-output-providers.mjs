import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DETACHED_PROCESS_GROUPS = process.platform !== 'win32';
const DEEPINFRA_CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';

function killChild(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (DETACHED_PROCESS_GROUPS) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    if (DETACHED_PROCESS_GROUPS && error?.code === 'EPERM') {
      try { child.kill(signal); } catch (childError) {
        if (childError?.code !== 'ESRCH' && childError?.code !== 'EPERM') throw childError;
      }
      return;
    }
    throw error;
  }
}

function runProcess({ command, args, input, timeoutMs, activeChildren }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: DETACHED_PROCESS_GROUPS,
    });
    activeChildren?.add(child);
    const stdout = [];
    const stderr = [];
    let hardKillTimer;
    const timeout = setTimeout(() => {
      killChild(child, 'SIGTERM');
      hardKillTimer = setTimeout(() => killChild(child, 'SIGKILL'), 10_000);
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      activeChildren?.delete(child);
      clearTimeout(timeout);
      clearTimeout(hardKillTimer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      activeChildren?.delete(child);
      clearTimeout(timeout);
      clearTimeout(hardKillTimer);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').slice(-20_000);
      reject(new Error(`${command} exited with ${code ?? signal}: ${detail}`));
    });
    child.stdin.end(input);
  });
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

export async function runClaudeStructured({
  prompt,
  schema,
  model,
  effort = 'high',
  timeoutMs,
  activeChildren = undefined,
  bin = process.env.CLAUDE_BIN || '/usr/local/bin/claude',
}) {
  const output = await runProcess({
    command: bin,
    args: [
      '-p', '--bare', '--model', model, '--effort', effort,
      '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      '--no-session-persistence',
    ],
    input: prompt,
    timeoutMs,
    activeChildren,
  });
  const envelope = parseJsonText(output, 'Claude');
  if (envelope.is_error) throw new Error(`Claude failed: ${envelope.result || envelope.subtype || 'unknown error'}`);
  return parseJsonText(envelope.structured_output ?? envelope.result, 'Claude structured output');
}

export async function runMetaStructured({
  prompt,
  schema,
  model,
  timeoutMs,
  activeChildren = undefined,
  apiKey = process.env.DEEPINFRA_API_KEY,
  bin = process.env.CURL_BIN || '/usr/bin/curl',
}) {
  if (!apiKey) throw new Error('DEEPINFRA_API_KEY is required for the Meta IPA worker');
  if (/[\r\n]/.test(apiKey)) throw new Error('DEEPINFRA_API_KEY contains an invalid newline');
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 12_000,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'sentence_ipa', strict: true, schema },
    },
  });
  const secretDir = mkdtempSync(join(tmpdir(), 'dictprop-meta-headers-'));
  const headerPath = join(secretDir, 'headers');
  const bodyPath = join(secretDir, 'body.json');
  writeFileSync(
    headerPath,
    `Authorization: Bearer ${apiKey}\nContent-Type: application/json\n`,
    { mode: 0o600 },
  );
  writeFileSync(bodyPath, body, { mode: 0o600 });
  let output;
  try {
    output = await runProcess({
      command: bin,
      args: [
        '-fsS', '--max-time', String(Math.ceil(timeoutMs / 1_000)),
        '--connect-timeout', '30',
        '--retry', '3', '--retry-all-errors', '--retry-delay', '3', '--retry-max-time', '180',
        '-H', `@${headerPath}`,
        '--data-binary', `@${bodyPath}`, DEEPINFRA_CHAT_URL,
      ],
      input: '',
      timeoutMs,
      activeChildren,
    });
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
  const envelope = parseJsonText(output, 'Meta');
  const content = envelope?.choices?.[0]?.message?.content;
  return parseJsonText(content, 'Meta structured output');
}
