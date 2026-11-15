import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256, writeExecutable } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

// Runs bootstrap-mflux-runtime.sh with a stand-in Python, whose venvs log every pip call, and a stand-in
// curl that serves a fixed archive, so nothing is downloaded or installed.

const ARCHIVE = 'pretend mflux source archive\n';

// `python -m venv DIR` makes a venv whose python logs its pip calls, and whether the archive pip was
// given exists, and answers the import check.
const PYTHON = `#!/bin/sh
if [ "$1" = -m ] && [ "$2" = venv ]; then
  mkdir -p "$3/bin"
  cat > "$3/bin/python" <<'VENV'
#!/bin/sh
if [ "$1" = - ]; then cat > /dev/null; echo model; exit 0; fi
for arg; do last="$arg"; done
case "$last" in */*) [ -f "$last" ] && state=present || state=missing; echo "$* (archive $state)" >> "$FAKE_PIP_LOG" ;; *) echo "$*" >> "$FAKE_PIP_LOG" ;; esac
VENV
  chmod +x "$3/bin/python"
  exit 0
fi
exit 1
`;

const CURL = `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output="$2"; shift; fi
  shift
done
printf '%s' "$FAKE_ARCHIVE" > "$output"
`;

function bootstrap(t: TestContext, archiveSha256: string) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-mflux-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeExecutable(join(bin, 'python3'), PYTHON);
  writeExecutable(join(bin, 'curl'), CURL);
  const cache = join(root, 'cache');
  const runtime = join(cache, 'mflux');
  const result = spawnSync('bash', [repoPath('scripts', 'offline', 'bootstrap-mflux-runtime.sh'), runtime], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      FAKE_ARCHIVE: ARCHIVE,
      FAKE_PIP_LOG: join(root, 'pip.log'),
      MFLUX_SOURCE_SHA256: archiveSha256,
    },
  });
  const pipLog = existsSync(join(root, 'pip.log')) ? readFileSync(join(root, 'pip.log'), 'utf8').trim().split('\n') : [];
  return { result, runtime, cache, pipLog };
}

test('the bootstrap installs the source archive only when it has the pinned hash, then removes it', t => {
  const { result, runtime, cache, pipLog } = bootstrap(t, sha256(ARCHIVE));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Installed persistent MFLUX runtime at .* from 97ac5e6280e8c65e48a609722229eb9d03ef2cbe/);
  // pip checks certificates for every install: no host is trusted without one.
  assert.equal(pipLog.length, 2);
  assert.equal(pipLog[0], '-m pip install mflux==0.18.0 uv==0.7.22 uv_build==0.7.22');
  assert.match(pipLog[1], /^-m pip install --no-deps --no-build-isolation --force-reinstall \S+\.tar\.gz \(archive present\)$/);
  assert.doesNotMatch(pipLog.join('\n'), /trusted-host/);
  assert.ok(existsSync(join(runtime, 'bin', 'python')));
  // The runtime is all that is left: no archive, no build directory.
  assert.deepEqual(readdirSync(cache), ['mflux']);
});

test('an archive with another hash is not installed, and nothing is left behind', t => {
  const { result, cache, pipLog } = bootstrap(t, sha256('a different archive\n'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /The mflux archive of 97ac5e6280e8c65e48a609722229eb9d03ef2cbe does not have the SHA-256 [0-9a-f]{64}; installing nothing/);
  assert.deepEqual(pipLog, ['-m pip install mflux==0.18.0 uv==0.7.22 uv_build==0.7.22']);
  assert.deepEqual(readdirSync(cache), []);
});
