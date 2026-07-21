import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test('publisher follows the exact fallback deployment it dispatches', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-publisher-'));
  const bin = join(root, 'bin');
  const fakeState = join(root, 'fake-state');
  mkdirSync(bin);
  mkdirSync(fakeState);
  const archive = join(root, 'offline-images.enc');
  writeFileSync(archive, 'encrypted archive');

  const fakeGh = join(bin, 'gh');
  writeExecutable(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
state="$FAKE_GH_STATE"
args="$*"
if [[ "$args" == "release view "* ]]; then echo 1; exit 0; fi
if [[ "$args" == "release upload "* || "$args" == "release delete "* ]]; then exit 0; fi
if [[ "$args" == "workflow run deploy.yml "* ]]; then touch "$state/deploy"; exit 0; fi
if [[ "$args" == "workflow run sentence-backfill.yml "* ]]; then touch "$state/import"; exit 0; fi
if [[ "$args" == "run list "*"--workflow deploy.yml"*"--commit"* ]]; then exit 0; fi
if [[ "$args" == "run list "*"--workflow deploy.yml"*"--event workflow_dispatch"* ]]; then
  if [[ -e "$state/deploy" ]]; then echo 101; else echo 100; fi
  exit 0
fi
if [[ "$args" == "run view 101 "* ]]; then printf '101\\tcompleted\\tsuccess\\thttps://deploy.test\\n'; exit 0; fi
if [[ "$args" == "run list "*"--workflow sentence-backfill.yml"* ]]; then
  if [[ -e "$state/import" ]]; then echo 201; else echo 200; fi
  exit 0
fi
if [[ "$args" == "run view 201 "*"--json jobs"* ]]; then echo image-import; exit 0; fi
if [[ "$args" == "run view 201 "* ]]; then printf 'completed\\tsuccess\\thttps://import.test\\n'; exit 0; fi
if [[ "$args" == "run rerun "* ]]; then exit 0; fi
echo "unexpected gh invocation: $args" >&2
exit 1
`);
  writeExecutable(join(bin, 'curl'), `#!/usr/bin/env bash
if [[ "$*" == *githubstatus.com* ]]; then
  printf '%s\\n' '{"components":[{"name":"API Requests","status":"operational"},{"name":"Actions","status":"operational"}]}'
fi
`);
  writeExecutable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');

  const tag = 'publisher-fallback-test';
  const output = execFileSync('bash', [
    resolve('..', 'scripts', 'offline', 'publish-backfill-release.sh'),
    tag,
    archive,
    'offline-images.enc',
    'image-import',
    'missing-deploy-sha',
    '0',
  ], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_GH_STATE: fakeState,
      GH_BIN: fakeGh,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      TMPDIR: root,
    },
  });

  const state = join(root, `dictprop-publish-${tag}`);
  assert.match(output, /required deployment succeeded; dispatching image-import import/);
  assert.equal(readFileSync(join(state, 'previous-deploy-run'), 'utf8').trim(), '100');
  assert.equal(readFileSync(join(state, 'deploy-run'), 'utf8').trim(), '101');
  assert.ok(existsSync(join(state, 'complete')));
  assert.ok(existsSync(join(fakeState, 'import')));
});
