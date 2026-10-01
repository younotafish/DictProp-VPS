import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const readRepoFile = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
  'utf8',
);
const workflow = (name: string): string => readRepoFile(`.github/workflows/${name}`);
const workflows = readdirSync(fileURLToPath(new URL('../../.github/workflows/', import.meta.url)))
  .filter(name => name.endsWith('.yml'))
  .map(name => ({ name, text: workflow(name) }));
/** The workflows that act on production and print to a public run log. */
const productionWorkflows = [
  'deploy.yml',
  'recover-production.yml',
  'diagnose-production.yml',
  'deploy-nz-japan.yml',
  'deploy-lake-loop.yml',
];
const hasPython = spawnSync('python3', ['--version']).status === 0;
/** ssh runs a remote script in root's login shell on the VPS, which is zsh, so these tests run it there too.
 *  -f leaves out this machine's zsh startup files. A step's run block runs in bash on the runner. */
const REMOTE_SHELL = ['zsh', '-f'] as const;

/** Splits a workflow into steps: each starts at a "- name:" or "- uses:" list item and runs to the next one. */
const steps = (text: string): string[] => text.split(/\n(?=\s+- (?:name|uses):)/);

/** The lines under `key:` at the given indentation, up to the next line indented no deeper. */
function entry(text: string, key: string, indent: number): string {
  const lines = text.split('\n');
  const head = `${' '.repeat(indent)}${key}:`;
  const start = lines.findIndex(line => line === head || line.startsWith(`${head} `));
  assert.notEqual(start, -1, `${key}: at indentation ${indent}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() !== '' && !line.startsWith(' '.repeat(indent + 1)));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/** A mapping's settings, without comments. */
const settings = (body: string): string[] => body.split('\n')
  .map(line => line.trim())
  .filter(line => line !== '' && !line.startsWith('#'));

/** The literal block under `key: |`, dedented, with the given workflow expressions filled in. */
function block(text: string, key: string, values: Record<string, string> = {}): string {
  const head = new RegExp(`^( *)${key}: \\|\\n`, 'm').exec(text);
  assert.ok(head, `${key}: | block`);
  const lines = text.slice(head.index + head[0].length).split('\n');
  const indent = lines[0].length - lines[0].trimStart().length;
  const end = lines.findIndex(line => line.trim() !== '' && !line.startsWith(' '.repeat(indent)));
  return lines.slice(0, end === -1 ? undefined : end)
    .map(line => line.slice(indent))
    .join('\n')
    .replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (expression, name: string) => values[name] ?? expression);
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'deploy-hardening-'));

function stub(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** A clean environment for scripts under test: the stubs first on PATH, and git kept off the user's config. */
const scriptEnv = (bin: string, variables: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  HOME: tmpdir(),
  TMPDIR: tmpdir(),
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Deploy Test',
  GIT_AUTHOR_EMAIL: 'deploy@example.com',
  GIT_COMMITTER_NAME: 'Deploy Test',
  GIT_COMMITTER_EMAIL: 'deploy@example.com',
  ...variables,
});

test('deploy.yml lets only the job that publishes the image write packages', () => {
  const deploy = workflow('deploy.yml');
  assert.deepEqual(settings(entry(deploy, 'permissions', 0)), ['contents: read']);
  assert.deepEqual(settings(entry(entry(deploy, 'build-image', 2), 'permissions', 4)), ['contents: read', 'packages: write']);
  assert.deepEqual(settings(entry(entry(deploy, 'deploy', 2), 'permissions', 4)), ['contents: read', 'packages: read']);
  assert.doesNotMatch(entry(deploy, 'verify', 2), /^ {4}permissions:/m);
  for (const { name, text } of workflows) {
    assert.equal(text.match(/packages: write/g)?.length ?? 0, name === 'deploy.yml' ? 1 : 0, name);
  }
});

test('every workflow defaults its token to read-only', () => {
  for (const { name, text } of workflows) {
    const defaults = settings(entry(text, 'permissions', 0));
    assert.ok(defaults.length > 0, name);
    for (const setting of defaults) assert.match(setting, /: (?:read|none)$/, `${name}: ${setting}`);
  }
});

test('no workflow splices a secret into a sed program', () => {
  for (const { name, text } of workflows) {
    const secretVariables = [...text.matchAll(/^\s+(\w+): \$\{\{ secrets\.\w+ \}\}/gm)].map(match => match[1]);
    for (const line of text.split('\n').filter(line => /\bsed\b/.test(line))) {
      assert.doesNotMatch(line, /secrets\./, `${name}: ${line.trim()}`);
      for (const variable of secretVariables) {
        assert.doesNotMatch(line, new RegExp(`\\$\\{?${variable}\\b`), `${name}: ${line.trim()}`);
      }
    }
  }
  const deploy = workflow('deploy.yml');
  assert.match(deploy, /printf 'DEEPINFRA_API_KEY=%s\\n' "\$DEEPINFRA_API_KEY" >> "\$ENV_TEMP"/);
  assert.match(deploy, /mv -f "\$ENV_TEMP" \.env/);
});

test('public run logs get no raw container logs', () => {
  for (const { name, text } of workflows) assert.doesNotMatch(text, /logs --tail[= ]200/, name);
  for (const name of productionWorkflows) {
    for (const line of workflow(name).split('\n').filter(line => /docker (?:compose )?logs\b/.test(line))) {
      assert.match(line, /> "\$log_file" 2>&1/, `${name}: ${line.trim()}`);
    }
  }
});

test('every script in the production workflows parses, and every remote script parses in zsh', () => {
  const parses = (name: string, script: string, [shell, ...options]: readonly string[]) => {
    const input = script.replace(/\$\{\{[^}]*\}\}/g, 'expression');
    const result = spawnSync(shell, [...options, '-n'], { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  };
  for (const { name, text } of workflows) {
    for (const step of steps(text)) {
      if (productionWorkflows.includes(name) && /^\s+run: \|$/m.test(step)) parses(name, block(step, 'run'), ['bash']);
      if (/^\s+script: \|$/m.test(step)) parses(name, block(step, 'script'), REMOTE_SHELL);
    }
  }
});

test('the image probes its own health over loopback', async () => {
  const dockerfile = readRepoFile('Dockerfile');
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  const healthcheck = /^HEALTHCHECK .*\\\n\s+CMD (\[.*\])$/m.exec(finalStage);
  assert.ok(healthcheck, 'the final stage has a HEALTHCHECK');
  const command = JSON.parse(healthcheck[1]) as string[];
  assert.equal(command[0], 'node');
  assert.match(command[2], /'http:\/\/127\.0\.0\.1:' \+ \(process\.env\.PORT \|\| 3000\) \+ '\/api\/health'/);

  let healthy = true;
  const server = createServer((request, response) => {
    response.statusCode = request.url === '/api/health' && healthy ? 200 : 503;
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const probe = () => new Promise<number>(resolve => {
    execFile(process.execPath, command.slice(1), { env: { PATH: process.env.PATH, PORT: String(port) } }, error => {
      resolve(error ? Number(error.code) : 0);
    });
  });
  try {
    assert.equal(await probe(), 0);
    healthy = false;
    assert.equal(await probe(), 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  assert.equal(await probe(), 1, 'nothing listening');
});

test('compose publishes the app on loopback only and forbids privilege gain', () => {
  const compose = readRepoFile('docker-compose.yml');
  const ports = settings(entry(compose, 'ports', 4));
  assert.ok(ports.length > 0);
  for (const port of ports) assert.match(port, /^- "127\.0\.0\.1:\d+:\d+"$/);
  assert.deepEqual(settings(entry(compose, 'security_opt', 4)), ['- no-new-privileges:true']);
});

test('no workflow carries a bcrypt hash, and nz-japan takes its hash from a secret', () => {
  for (const { name, text } of workflows) assert.doesNotMatch(text, /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/, name);
  const configure = steps(workflow('deploy-nz-japan.yml')).find(step => step.includes('uses: appleboy/ssh-action@'));
  assert.ok(configure);
  assert.match(configure, /^ {10}NZ_JAPAN_BASIC_AUTH_HASH: \$\{\{ secrets\.NZ_JAPAN_BASIC_AUTH_HASH \}\}$/m);
  assert.match(configure, /^ {10}envs: NZ_JAPAN_BASIC_AUTH_HASH$/m);
});

test('both trip sites send a content security policy and check for it after the reload', () => {
  for (const [name, inputs] of [
    ['deploy-nz-japan.yml', ['asset_id', 'archive_sha256']],
    ['deploy-lake-loop.yml', ['archive_b64']],
  ] as const) {
    const text = workflow(name);
    const csp = /^\s+csp="(.*)"$/m.exec(text)?.[1];
    assert.ok(csp, name);
    const directives = csp.split('; ');
    assert.equal(directives[0], "default-src 'self'", name);
    for (const directive of ["object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
      assert.ok(directives.includes(directive), `${name}: ${directive}`);
    }
    assert.doesNotMatch(csp, /unsafe-|https?:|\*/, name);
    for (const header of ['Content-Security-Policy "$csp"', 'X-Content-Type-Options "nosniff"', 'Referrer-Policy "no-referrer"']) {
      assert.ok(text.includes(header), `${name}: ${header}`);
    }
    assert.ok(text.includes(`grep -Fqix "content-security-policy: $csp"`), name);
    // Without an archive, the run reapplies only the route.
    for (const input of inputs) assert.ok(settings(entry(text, input, 6)).includes('required: false'), `${name}: ${input}`);
  }
});

const RUN_ID = '4242';
const RELEASE_IMAGE = 'ghcr.io/younotafish/dictprop-vps:candidate';

/** deploy.yml's server script in three parts: checkout and exit trap, the .env update, and the release. */
function deployScript() {
  const script = block(workflow('deploy.yml'), 'script', {
    'github.run_id': RUN_ID,
    'github.run_attempt': '1',
    'github.sha': 'candidate',
  });
  assert.doesNotMatch(script, /\$\{\{/);
  const lines = script.split('\n');
  const at = (marker: string): number => {
    const index = lines.findIndex(line => line.includes(marker));
    assert.notEqual(index, -1, marker);
    return index;
  };
  assert.deepEqual(lines.slice(0, 2), ['set -e', 'cd /opt/dictprop-vps']);
  return {
    checkout: ['set -e', 'cd "$DEPLOY_DIR"', ...lines.slice(2, at('git pull --ff-only origin main') + 1)].join('\n'),
    env: lines.slice(at('# Sync the DeepInfra key'), at('=== PULLING PREBUILT RELEASE ===')).join('\n'),
    release: lines.slice(at('=== PULLING PREBUILT RELEASE ===')).join('\n'),
  };
}

interface DeployRun {
  status: number | null;
  output: string;
  /** Each docker call, with the image and client config it ran with and the commit then checked out. */
  calls: string[];
}

/** A real git checkout standing in for /opt/dictprop-vps, with docker, curl and sleep stubbed. */
function makeServer() {
  const dir = scratch();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls.log');
  const running = join(dir, 'running');
  writeFileSync(running, 'previous-image\n');
  stub(bin, 'docker', String.raw`
printf 'docker %s | image=%s config=%s head=%s\n' "$*" "$DICTPROP_IMAGE" "$DOCKER_CONFIG" "$(git rev-parse HEAD)" >> "$CALLS"
case "$1 $2" in
  'login ghcr.io') cat > /dev/null; echo '{"auths":{"ghcr.io":{}}}' > "$DOCKER_CONFIG/config.json" ;;
  'pull '*) [ -z "$FAIL_PULL" ] ;;
  'compose ps') [ -n "$NO_PREVIOUS" ] || echo app-container ;;
  'compose up')
    if [ "$DICTPROP_IMAGE" = "$RELEASE_IMAGE" ] && [ -n "$FAIL_UP" ]; then exit 1; fi
    echo "$DICTPROP_IMAGE" > "$RUNNING" ;;
  'inspect --format')
    case "$3" in
      *.Image*) echo sha256:previous ;;
      *) echo 'App container: exited, exit code 1, 0 restarts, OOM-killed false' ;;
    esac ;;
  'logs --timestamps')
    echo '2026-10-01T00:00:00Z [migrate] schema is current'
    echo '2026-10-01T00:00:01Z GET /api/items 200 12ms'
    echo '2026-10-01T00:00:02Z Error: could not save "a private sentence"'
    echo "2026-10-01T00:00:03Z Error: no entry for 'another private sentence'"
    echo '2026-10-01T00:00:04Z Server running on port 3000' ;;
esac`);
  stub(bin, 'curl', String.raw`
if [ "$(cat "$RUNNING")" = "$RELEASE_IMAGE" ]; then [ -z "$FAIL_HEALTH" ]; else [ -z "$FAIL_ROLLBACK" ]; fi`);
  stub(bin, 'sleep', 'exit 0');

  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync('git', args, { cwd, env: scriptEnv(bin, {}), encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const app = join(dir, 'app');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(dir, 'init', '--quiet', '--initial-branch=main', work);
  git(work, 'remote', 'add', 'origin', origin);
  /** Pushes a new commit to main, as merging a release would, and returns its SHA. */
  const publish = (message: string): string => {
    writeFileSync(join(work, '.gitignore'), 'data/\n.env\n');
    writeFileSync(join(work, 'docker-compose.yml'), `# ${message}\n`);
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', message);
    git(work, 'push', '--quiet', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const previous = publish('previous release');
  git(dir, 'clone', '--quiet', origin, app);

  const deploy = (part: 'env' | 'release', variables: Record<string, string> = {}): DeployRun => {
    const script = deployScript();
    const result = spawnSync(REMOTE_SHELL[0], [...REMOTE_SHELL.slice(1), '-c', `${script.checkout}\n${script[part]}\n`], {
      cwd: app,
      encoding: 'utf8',
      env: scriptEnv(bin, {
        DEPLOY_DIR: app,
        CALLS: calls,
        RUNNING: running,
        RELEASE_IMAGE,
        GHCR_TOKEN: 'registry-token',
        GHCR_USERNAME: 'deployer',
        DEEPINFRA_API_KEY: '',
        ...variables,
      }),
    });
    const logged = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    rmSync(calls, { force: true });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: logged };
  };

  return {
    app,
    previous,
    publish,
    deploy,
    head: () => git(app, 'rev-parse', 'HEAD'),
    branch: () => git(app, 'rev-parse', '--abbrev-ref', 'HEAD'),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const composeUps = (run: DeployRun): string[] => run.calls.filter(call => call.startsWith('docker compose up'));

test('a release that will not start rolls back on the checkout it came from, and the next deploy still works', () => {
  const server = makeServer();
  try {
    const logs = join(server.app, 'data', 'deploy-logs');
    mkdirSync(logs, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(join(logs, `old-${index}.log`), '');
      utimesSync(join(logs, `old-${index}.log`), 1_700_000_000 + index, 1_700_000_000 + index);
    }
    const candidate = server.publish('broken release');
    const run = server.deploy('release', { FAIL_UP: '1' });

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /::error::The new release could not be started/);
    const [release, rollback, ...rest] = composeUps(run);
    assert.deepEqual(rest, []);
    assert.ok(release.endsWith(`| image=${RELEASE_IMAGE} config= head=${candidate}`), release);
    // The previous image comes back up with the compose file it was deployed with.
    assert.ok(rollback.endsWith(`| image=dictprop-vps:rollback-${RUN_ID} config= head=${server.previous}`), rollback);
    assert.match(run.output, new RegExp(`Rollback to ${server.previous} is healthy`));
    assert.equal(server.head(), server.previous);

    // Registry credentials live only in a throwaway config for the login and pull.
    assert.match(run.calls[0], /^docker logout ghcr\.io \| image= config= /);
    const registryCalls = run.calls.filter(call => / config=\S/.test(call));
    assert.deepEqual(registryCalls.map(call => call.split(' ')[1]), ['login', 'pull']);
    const registryConfig = / config=(\S+)/.exec(registryCalls[0])?.[1] ?? '';
    assert.ok(registryCalls[1].includes(` config=${registryConfig} `));
    assert.ok(!existsSync(registryConfig), 'the registry config is removed');

    // The run log gets the container state and masked startup and error lines; the full tail stays on the server.
    assert.match(run.output, /App container: exited, exit code 1/);
    assert.match(run.output, /\[migrate\] schema is current/);
    assert.match(run.output, /Error: could not save "\.\.\."/);
    assert.match(run.output, /Error: no entry for '\.\.\.'/);
    assert.doesNotMatch(run.output, /private sentence|GET \/api\/items/);
    const logFile = `data/deploy-logs/${RUN_ID}-1-release.log`;
    assert.ok(run.output.includes(`/opt/dictprop-vps/${logFile}`));
    assert.equal(statSync(join(server.app, logFile)).mode & 0o777, 0o600);
    assert.equal(statSync(logs).mode & 0o777, 0o700);
    assert.match(readFileSync(join(server.app, logFile), 'utf8'), /a private sentence/);
    const kept = readdirSync(logs);
    assert.equal(kept.length, 10);
    assert.ok(kept.includes(`${RUN_ID}-1-release.log`) && kept.includes('old-3.log') && !kept.includes('old-2.log'));

    // The release part never touches the backup slot the earlier part manages.
    assert.doesNotMatch(deployScript().release, /backups/);

    const fixed = server.publish('fixed release');
    const retry = server.deploy('release');
    assert.equal(retry.status, 0, retry.output);
    assert.match(retry.output, /Release is healthy/);
    assert.equal(server.head(), fixed);
    assert.equal(server.branch(), 'main');
    assert.equal(composeUps(retry).length, 1);
    assert.ok(composeUps(retry)[0].endsWith(`| image=${RELEASE_IMAGE} config= head=${fixed}`));
  } finally {
    server.remove();
  }
});

test('a release that fails its health checks is rolled back the same way', () => {
  const server = makeServer();
  try {
    server.publish('unhealthy release');
    const run = server.deploy('release', { FAIL_HEALTH: '1' });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /::error::The new release failed health checks/);
    assert.ok(composeUps(run)[1].endsWith(`| image=dictprop-vps:rollback-${RUN_ID} config= head=${server.previous}`));
    assert.match(run.output, /is healthy/);
    assert.equal(server.head(), server.previous);
  } finally {
    server.remove();
  }
});

test('a failed rollback still ends red, on the previous checkout, with both logs kept', () => {
  const server = makeServer();
  try {
    server.publish('broken release');
    const run = server.deploy('release', { FAIL_UP: '1', FAIL_ROLLBACK: '1' });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /::error::The rollback failed too/);
    assert.equal(server.head(), server.previous);
    for (const label of ['release', 'rollback']) {
      assert.ok(existsSync(join(server.app, 'data', 'deploy-logs', `${RUN_ID}-1-${label}.log`)), label);
    }
  } finally {
    server.remove();
  }
});

test('with no earlier container there is nothing to roll back, but the checkout is still restored', () => {
  const server = makeServer();
  try {
    server.publish('first release');
    const run = server.deploy('release', { FAIL_UP: '1', NO_PREVIOUS: '1' });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /nothing to roll back to/);
    assert.equal(composeUps(run).length, 1);
    assert.equal(server.head(), server.previous);
  } finally {
    server.remove();
  }
});

test('a deploy that fails before the release starts restores the checkout and drops the registry login', () => {
  const server = makeServer();
  try {
    server.publish('unpullable release');
    const run = server.deploy('release', { FAIL_PULL: '1' });
    assert.notEqual(run.status, 0, run.output);
    assert.deepEqual(composeUps(run), []);
    assert.equal(server.head(), server.previous);
    const registryConfig = / config=(\S+)/.exec(run.calls.find(call => call.startsWith('docker login')) ?? '')?.[1];
    assert.ok(registryConfig && !existsSync(registryConfig), 'the registry config is removed');
  } finally {
    server.remove();
  }
});

test('the DeepInfra key reaches .env as data, in one rename that keeps the file mode', () => {
  const server = makeServer();
  const envFile = join(server.app, '.env');
  const leftovers = () => readdirSync(server.app).filter(name => name.startsWith('.env.'));
  try {
    writeFileSync(envFile, 'GOOGLE_CLIENT_ID=client\nDEEPINFRA_API_KEY=old\nPUBLIC_ORIGIN=https://dictprop.online\n');
    chmodSync(envFile, 0o640);
    const key = String.raw`new|&\/$'"key`;
    let run = server.deploy('env', { DEEPINFRA_API_KEY: key });
    assert.equal(run.status, 0, run.output);
    assert.equal(
      readFileSync(envFile, 'utf8'),
      `GOOGLE_CLIENT_ID=client\nPUBLIC_ORIGIN=https://dictprop.online\nDEEPINFRA_API_KEY=${key}\n`,
    );
    assert.equal(statSync(envFile).mode & 0o777, 0o640);
    assert.deepEqual(leftovers(), []);

    const before = readFileSync(envFile, 'utf8');
    run = server.deploy('env', { DEEPINFRA_API_KEY: '' });
    assert.equal(run.status, 0, run.output);
    assert.equal(readFileSync(envFile, 'utf8'), before, 'an empty secret leaves the key alone');

    for (const injected of ['next\nPUBLIC_ORIGIN=https://attacker.example', 'next\rline']) {
      run = server.deploy('env', { DEEPINFRA_API_KEY: injected });
      assert.notEqual(run.status, 0);
      assert.match(run.output, /contains a control character/);
      assert.equal(readFileSync(envFile, 'utf8'), before);
      assert.deepEqual(leftovers(), []);
    }

    rmSync(envFile);
    run = server.deploy('env', { DEEPINFRA_API_KEY: 'fresh' });
    assert.equal(run.status, 0, run.output);
    assert.equal(readFileSync(envFile, 'utf8'), 'DEEPINFRA_API_KEY=fresh\n');
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
  } finally {
    server.remove();
  }
});

const BCRYPT_HASH = `$2y$12$${'A'.repeat(50)}./9`;

test('nz-japan uploads only when given both archive inputs, and checks the hash before anything else', () => {
  const step = steps(workflow('deploy-nz-japan.yml')).find(text => /\n\s+id: mode\n/.test(text));
  assert.ok(step);
  const script = block(step, 'run');
  const dir = scratch();
  try {
    const mode = (variables: Record<string, string>) => {
      const output = join(dir, 'output');
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          ASSET_ID: '',
          ARCHIVE_SHA256: '',
          NZ_JAPAN_BASIC_AUTH_HASH: BCRYPT_HASH,
          ...variables,
        },
      });
      return { status: result.status, output: readFileSync(output, 'utf8') };
    };
    const sha256 = 'aB'.repeat(32);
    assert.deepEqual(mode({}), { status: 0, output: 'upload=false\n' });
    assert.deepEqual(mode({ ASSET_ID: '301234567', ARCHIVE_SHA256: sha256 }), { status: 0, output: 'upload=true\n' });
    const refused: Record<string, string>[] = [
      { ASSET_ID: '301234567' },
      { ARCHIVE_SHA256: sha256 },
      { ASSET_ID: '../301234567', ARCHIVE_SHA256: sha256 },
      { ASSET_ID: '301234567', ARCHIVE_SHA256: sha256.slice(1) },
    ];
    for (const inputs of refused) {
      assert.deepEqual(mode(inputs), { status: 1, output: '' }, JSON.stringify(inputs));
    }
    for (const hash of ['', '$2y$12$tooshort', BCRYPT_HASH.replace('$2y', '$2x'), `${BCRYPT_HASH}\n`]) {
      assert.deepEqual(mode({ NZ_JAPAN_BASIC_AUTH_HASH: hash }), { status: 1, output: '' }, JSON.stringify(hash));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface RouteOptions {
  hash?: string;
  status: string;
  location?: string;
  /** A policy the upstream app adds to its own redirect, as the auth gate does. */
  appCsp?: string;
  /** Answers as if Caddy had not applied the route's headers. */
  omitRouteCsp?: boolean;
}

/** Runs a trip workflow's Caddy step on a scratch Caddyfile, prefixed with the exports drone-ssh writes for `envs:`. */
function configureTripRoute(name: string, options: RouteOptions) {
  const dir = scratch();
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const command of ['chown', 'caddy', 'systemctl']) stub(bin, command, 'exit 0');
    // Answers as Caddy would: the route's headers as configured, plus whatever the app adds upstream.
    stub(bin, 'curl', String.raw`
while [ $# -gt 0 ]; do
  [ "$1" = -D ] && headers="$2"
  shift
done
route_policy="$(sed -n 's/^ *Content-Security-Policy "\(.*\)"$/\1/p' "$CADDYFILE")"
{
  printf 'HTTP/2 %s\r\n' "$RESPONSE_STATUS"
  [ -z "$APP_CSP" ] || printf 'content-security-policy: %s\r\n' "$APP_CSP"
  [ -n "$OMIT_ROUTE_CSP" ] || printf 'content-security-policy: %s\r\n' "$route_policy"
  [ -z "$RESPONSE_LOCATION" ] || printf 'location: %s\r\n' "$RESPONSE_LOCATION"
  printf '\r\n'
} > "$headers"
printf '%s' "$RESPONSE_STATUS"`);

    const step = steps(workflow(name)).find(text => text.includes('uses: appleboy/ssh-action@'));
    assert.ok(step);
    const original = block(step, 'script');
    const site = /^test -s \/var\/www\/([\w-]+)\/index\.html$/m.exec(original)?.[1];
    const marker = /^begin = "(# BEGIN MANAGED [A-Z0-9 ]+)"$/m.exec(original)?.[1];
    const csp = /^csp="(.*)"$/m.exec(original)?.[1];
    assert.ok(site && marker && csp);
    mkdirSync(join(dir, 'var', 'www', site), { recursive: true });
    writeFileSync(join(dir, 'var', 'www', site, 'index.html'), 'site');
    mkdirSync(join(dir, 'etc', 'caddy'), { recursive: true });
    const caddyfile = join(dir, 'etc', 'caddy', 'Caddyfile');
    const before = [
      'dictprop.online, www.dictprop.online {',
      `    ${marker}`,
      '    respond "earlier route"',
      `    ${marker.replace('BEGIN', 'END')}`,
      '    reverse_proxy localhost:3000',
      '}',
      '',
    ].join('\n');
    writeFileSync(caddyfile, before);

    const values: Record<string, string> = { NZ_JAPAN_BASIC_AUTH_HASH: options.hash ?? '' };
    const exported = (/^\s+envs: (.+)$/m.exec(step)?.[1].split(',') ?? [])
      .map(variable => `export ${variable}='${(values[variable] ?? '').replaceAll("'", String.raw`'\''`)}'\n`)
      .join('');
    const script = original.replaceAll('/var/www/', `${dir}/var/www/`).replaceAll('/etc/caddy/', `${dir}/etc/caddy/`);
    const result = spawnSync(REMOTE_SHELL[0], [...REMOTE_SHELL.slice(1), '-c', `${exported}${script}`], {
      encoding: 'utf8',
      env: scriptEnv(bin, {
        CADDYFILE: caddyfile,
        RESPONSE_STATUS: options.status,
        RESPONSE_LOCATION: options.location ?? '',
        APP_CSP: options.appCsp ?? '',
        OMIT_ROUTE_CSP: options.omitRouteCsp ? '1' : '',
      }),
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      before,
      after: readFileSync(caddyfile, 'utf8'),
      marker,
      csp,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the nz-japan route takes the secret hash intact and must answer 401 with its policy', t => {
  if (!hasPython) return t.skip('python3 is not installed');
  const deployed = configureTripRoute('deploy-nz-japan.yml', { hash: BCRYPT_HASH, status: '401' });
  assert.equal(deployed.status, 0, deployed.output);
  assert.equal(deployed.after.split(deployed.marker).length, 2, 'the managed block is replaced, not duplicated');
  assert.ok(deployed.after.includes(`travel ${BCRYPT_HASH}\n`), 'the hash keeps its $ signs');
  assert.ok(deployed.after.includes(`Content-Security-Policy "${deployed.csp}"`));
  assert.doesNotMatch(deployed.after, /earlier route/);
  assert.match(deployed.after, /reverse_proxy localhost:3000/);

  assert.notEqual(configureTripRoute('deploy-nz-japan.yml', { hash: BCRYPT_HASH, status: '200' }).status, 0);
  assert.notEqual(configureTripRoute('deploy-nz-japan.yml', { hash: BCRYPT_HASH, status: '401', omitRouteCsp: true }).status, 0);
  for (const hash of ['', '$2y$12$tooshort', `${BCRYPT_HASH}'; echo injected; '`]) {
    const refused = configureTripRoute('deploy-nz-japan.yml', { hash, status: '401' });
    assert.notEqual(refused.status, 0, JSON.stringify(hash));
    assert.match(refused.output, /must be a bcrypt hash/);
    assert.doesNotMatch(refused.output, /^injected$/m);
    assert.equal(refused.after, refused.before);
  }
});

test("the Lake Loop route must answer its redirect with its own policy, not only the app's", t => {
  if (!hasPython) return t.skip('python3 is not installed');
  const options = {
    status: '302',
    location: '/api/auth/login?returnTo=%2Flake-loop-26%2F',
    appCsp: "default-src 'self'; base-uri 'self'; object-src 'none'",
  };
  const deployed = configureTripRoute('deploy-lake-loop.yml', options);
  assert.equal(deployed.status, 0, deployed.output);
  assert.ok(deployed.after.includes(`Content-Security-Policy "${deployed.csp}"`));
  assert.match(deployed.csp, /; img-src 'self' data:;/);
  assert.notEqual(configureTripRoute('deploy-lake-loop.yml', { ...options, omitRouteCsp: true }).status, 0);
});
