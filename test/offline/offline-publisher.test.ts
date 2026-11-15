import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeExecutable } from '../support/fs.ts';
import { repoPath, SERVER_DIR } from '../support/paths.ts';

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
printf '%s\\n' "$args" >> "$state/gh.log"
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
if [[ "$args" == "run view 201 "*"--json status,conclusion,jobs"* ]]; then echo operation-job; exit 0; fi
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
  // A full SHA this checkout has never fetched: it has no deployment of its own.
  const output = execFileSync('bash', [
    repoPath('scripts', 'offline', 'publish-backfill-release.sh'),
    tag,
    archive,
    'offline-images.enc',
    'image-import',
    'deadbeef'.repeat(5),
    '0',
  ], {
    cwd: SERVER_DIR,
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
  const ghLog = readFileSync(join(fakeState, 'gh.log'), 'utf8');
  assert.match(output, /no deployment run exists for (deadbeef){5}; dispatching it explicitly/);
  assert.match(output, /required deployment succeeded; dispatching image-import import/);
  assert.equal(ghLog.match(/^workflow run deploy\.yml /gm)?.length, 1);
  // The deployment the dispatch started (101), not the newest one before it (100), is followed.
  assert.match(ghLog, /^run view 101 /m);
  assert.doesNotMatch(ghLog, /^run view 100 /m);
  assert.ok(existsSync(join(state, 'complete')));
  assert.ok(existsSync(join(fakeState, 'import')));
});

test('publisher retries a workflow that fails before any import job starts', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-publisher-startup-'));
  const bin = join(root, 'bin');
  const fakeState = join(root, 'fake-state');
  mkdirSync(bin);
  mkdirSync(fakeState);
  const archive = join(root, 'sentence-enrichments.enc');
  writeFileSync(archive, 'encrypted archive');

  const fakeGh = join(bin, 'gh');
  writeExecutable(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
state="$FAKE_GH_STATE"
args="$*"
if [[ "$args" == "release view "* ]]; then echo 1; exit 0; fi
if [[ "$args" == "release upload "* || "$args" == "release delete "* ]]; then exit 0; fi
if [[ "$args" == "workflow run sentence-backfill.yml "* ]]; then
  count="$(cat "$state/import-count" 2>/dev/null || echo 0)"
  echo "$((count + 1))" > "$state/import-count"
  exit 0
fi
if [[ "$args" == "run list "*"--workflow deploy.yml"*"--commit"* ]]; then
  printf '100\tcompleted\tsuccess\thttps://deploy.test\n'
  exit 0
fi
if [[ "$args" == "run list "*"--workflow sentence-backfill.yml"* ]]; then
  count="$(cat "$state/import-count" 2>/dev/null || echo 0)"
  if [[ "$count" -ge 2 ]]; then echo 302
  elif [[ "$count" -eq 1 ]]; then echo 301
  else echo 300
  fi
  exit 0
fi
if [[ "$args" == "run view 301 "*"--json status,conclusion,jobs"* ]]; then echo workflow-startup-failure; exit 0; fi
if [[ "$args" == "run view 301 "* ]]; then printf 'completed\tstartup_failure\thttps://failed.test\n'; exit 0; fi
if [[ "$args" == "run view 302 "*"--json status,conclusion,jobs"* ]]; then echo operation-job; exit 0; fi
if [[ "$args" == "run view 302 "* ]]; then printf 'completed\tsuccess\thttps://import.test\n'; exit 0; fi
echo "unexpected gh invocation: $args" >&2
exit 1
`);
  writeExecutable(join(bin, 'curl'), `#!/usr/bin/env bash
if [[ "$*" == *githubstatus.com* ]]; then
  printf '%s\n' '{"components":[{"name":"API Requests","status":"operational"},{"name":"Actions","status":"operational"}]}'
else
  exit 0
fi
`);
  writeExecutable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');

  const tag = 'publisher-startup-failure-test';
  const output = execFileSync('bash', [
    repoPath('scripts', 'offline', 'publish-backfill-release.sh'),
    tag,
    archive,
    'sentence-enrichments.enc',
    'enrichment-import',
    'HEAD',
    '0',
  ], {
    cwd: SERVER_DIR,
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
  assert.match(output, /identified failed import workflow 301 before any job started/);
  assert.match(output, /import 301 ended as startup_failure/);
  assert.equal(readFileSync(join(fakeState, 'import-count'), 'utf8').trim(), '2');
  assert.ok(existsSync(join(state, 'complete')));
});

// Answers like gh, including --jq, over a shared list of bridge runs. Every dispatch adds this
// release's run and, at the same moment, a run another release dispatched.
// FAKE_GH_FAIL=<text>@<n> fails the nth call that mentions <text>, as GitHub does now and then with a 502.
// FAKE_DEPLOY_STATES lists the deployment's status at each lookup; the last one repeats.
const fakeGhWithRuns = `#!/usr/bin/env bash
set -euo pipefail
state="$FAKE_GH_STATE"
printf '%s\n' "$*" >> "$state/gh.log"
if [ -n "\${FAKE_GH_FAIL:-}" ] && [[ "$*" == *"\${FAKE_GH_FAIL%@*}"* ]]; then
  seen=$(( $(cat "$state/fail-count" 2>/dev/null || echo 0) + 1 ))
  printf '%s\n' "$seen" > "$state/fail-count"
  if [ "$seen" -eq "\${FAKE_GH_FAIL##*@}" ]; then echo 'HTTP 502: Bad Gateway' >&2; exit 1; fi
fi
filter=.
previous=
for arg in "$@"; do
  if [ "$previous" = --jq ]; then filter="$arg"; fi
  previous="$arg"
done
respond() { jq -r "$filter"; }
case "$*" in
  "release view "*)
    printf '%s\n' '{"assets":[{"name":"sentence-backfill.enc"}]}' | respond ;;
  "release upload "* | "release delete "*) ;;
  "run list "*"--workflow deploy.yml"*)
    lookups=$(( $(cat "$state/deploy-lookups" 2>/dev/null || echo 0) + 1 ))
    printf '%s\n' "$lookups" > "$state/deploy-lookups"
    status="$(printf '%s\n' "\${FAKE_DEPLOY_STATES:-completed}" | awk -F, -v n="$lookups" '{ print (n <= NF ? $n : $NF) }')"
    conclusion=success
    if [ "$status" != completed ]; then conclusion=; fi
    jq -n --arg status "$status" --arg conclusion "$conclusion" \\
      '[{databaseId: 100, status: $status, conclusion: (if $conclusion == "" then null else $conclusion end), url: "https://deploy.test"}]' | respond ;;
  "run list "*"--workflow sentence-backfill.yml"*)
    respond < "$state/import-runs.json" ;;
  "run view "*)
    jq --argjson id "$3" '.[] | select(.databaseId == $id)' "$state/import-runs.json" | respond ;;
  "workflow run sentence-backfill.yml "*)
    count=$(( $(cat "$state/import-count" 2>/dev/null || echo 0) + 1 ))
    printf '%s\n' "$count" > "$state/import-count"
    conclusion="$(printf '%s\n' "$FAKE_IMPORT_CONCLUSIONS" | awk -F, -v n="$count" '{ print $n }')"
    if [ -z "$conclusion" ]; then conclusion=success; fi
    tag="$(printf '%s\n' "$*" | sed -n 's/.*release_tag=\\([^ ]*\\).*/\\1/p')"
    jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg tag "$tag" --arg conclusion "$conclusion" --argjson n "$count" '
      [{databaseId: (600 + 2 * $n), createdAt: $now, displayTitle: ("import " + $tag), status: "completed",
        conclusion: $conclusion, url: "https://import.test/ours", jobs: [{name: "import", conclusion: $conclusion}]},
       {databaseId: (599 + 2 * $n), createdAt: $now, displayTitle: "import sentence-grammar-wave-0009-20260101T000000Z",
        status: "completed", conclusion: "failure", url: "https://import.test/other",
        jobs: [{name: "import", conclusion: "failure"}]}] + .' "$state/import-runs.json" > "$state/import-runs.next"
    mv "$state/import-runs.next" "$state/import-runs.json" ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 1 ;;
esac
`;

const bridgeTag = 'sentence-grammar-wave-0001-20260928T000000Z';
// The fixture runs outside any checkout, so the publisher takes the commit as given.
const deploySha = 'feed'.repeat(10);

function bridgeFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(root, 'bin');
  const fakeState = join(root, 'fake-state');
  const stateDir = join(root, 'publisher');
  mkdirSync(bin);
  mkdirSync(fakeState);
  const archive = join(root, 'sentence-backfill.enc');
  writeFileSync(archive, 'encrypted wave');
  writeFileSync(join(fakeState, 'import-runs.json'), JSON.stringify([{
    databaseId: 599, createdAt: '2026-01-01T00:00:00Z', displayTitle: 'import an-older-release',
    status: 'completed', conclusion: 'success', url: 'https://import.test/older', jobs: [],
  }]));
  writeExecutable(join(bin, 'gh'), fakeGhWithRuns);
  writeExecutable(join(bin, 'git'), '#!/bin/sh\nexit 1\n');
  writeExecutable(join(bin, 'curl'), `#!/usr/bin/env bash
if [[ "$*" == *githubstatus.com* ]]; then
  if [ "$FAKE_STATUS_PAGE" = down ]; then exit 7; fi
  printf '{"components":[{"name":"API Requests","status":"operational"},{"name":"Actions","status":"%s"}]}\n' "$FAKE_ACTIONS_STATUS"
fi
`);
  writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nif [ -n "$FAKE_REAL_SLEEP" ]; then exec /bin/sleep "$@"; fi\n');
  const publish = (env: Record<string, string> = {}, pollSeconds = '0', sha = deploySha) => spawnSync('bash', [
    repoPath('scripts', 'offline', 'publish-backfill-release.sh'),
    bridgeTag, archive, 'sentence-backfill.enc', 'import', sha, pollSeconds,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      FAKE_ACTIONS_STATUS: 'operational',
      FAKE_DEPLOY_STATES: '',
      FAKE_GH_FAIL: '',
      FAKE_GH_STATE: fakeState,
      FAKE_IMPORT_CONCLUSIONS: '',
      FAKE_REAL_SLEEP: '',
      FAKE_STATUS_PAGE: '',
      GH_BIN: join(bin, 'gh'),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PUBLISH_STATE_DIR: stateDir,
      TMPDIR: root,
      ...env,
    },
  });
  const ghLog = () => existsSync(join(fakeState, 'gh.log')) ? readFileSync(join(fakeState, 'gh.log'), 'utf8') : '';
  const dispatches = () => Number(readFileSync(join(fakeState, 'import-count'), 'utf8').trim());
  const uploads = () => ghLog().match(/^release upload /gm)?.length ?? 0;
  return { root, stateDir, publish, ghLog, dispatches, uploads };
}

const uploadWithClobber = /^release upload \S+ \S+ --repo \S+ --clobber$/m;
const releaseDelete = new RegExp(`^release delete ${bridgeTag} --repo \\S+ --yes --cleanup-tag$`, 'm');

test('publisher follows its own import run, not one another release dispatched at the same time', () => {
  const fixture = bridgeFixture('dictprop-publisher-own-run-');
  try {
    const result = fixture.publish();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.dispatches(), 1);
    // 602 is this release's run; 601, dispatched at the same moment for another release, is never read.
    assert.match(fixture.ghLog(), /^run view 602 /m);
    assert.doesNotMatch(fixture.ghLog(), /^run view 601 /m);
    assert.doesNotMatch(result.stdout, /ended as failure/);
    assert.match(fixture.ghLog(), releaseDelete);
    assert.ok(existsSync(join(fixture.stateDir, 'complete')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a publisher starts over whatever state an earlier publisher left', () => {
  const fixture = bridgeFixture('dictprop-publisher-rebuilt-');
  try {
    // Files an earlier publisher version kept: its upload, its spent attempts, and its import run.
    mkdirSync(fixture.stateDir);
    writeFileSync(join(fixture.stateDir, 'archive-sha256'), 'earlier-archive\n');
    writeFileSync(join(fixture.stateDir, 'uploaded-sha256'), 'earlier-archive\n');
    writeFileSync(join(fixture.stateDir, 'import-dispatch-count'), '3\n');
    writeFileSync(join(fixture.stateDir, 'import-triggered'), 'earlier\n');
    writeFileSync(join(fixture.stateDir, 'import-run'), '999\n');

    const result = fixture.publish();
    assert.equal(result.status, 0, result.stderr);
    assert.match(fixture.ghLog(), uploadWithClobber);
    assert.doesNotMatch(fixture.ghLog(), /run view 999/);
    assert.equal(fixture.dispatches(), 1);
    assert.ok(existsSync(join(fixture.stateDir, 'complete')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('publisher deletes the release when imports keep failing, and a later run starts over', () => {
  const fixture = bridgeFixture('dictprop-publisher-give-up-');
  try {
    const env = { FAKE_IMPORT_CONCLUSIONS: 'failure,failure,failure' };

    const failed = fixture.publish(env);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /import 602 ended as failure/);
    assert.match(failed.stdout, /import failed three fresh workflows; stopping for inspection/);
    assert.equal(fixture.uploads(), 1);
    assert.match(fixture.ghLog(), releaseDelete);
    assert.equal(fixture.dispatches(), 3);
    assert.ok(existsSync(join(fixture.stateDir, 'failed')));

    // The fourth workflow succeeds.
    const retried = fixture.publish(env);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(fixture.uploads(), 2);
    assert.equal(fixture.dispatches(), 4);
    assert.equal(existsSync(join(fixture.stateDir, 'failed')), false);
    assert.ok(existsSync(join(fixture.stateDir, 'complete')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('publisher retries a cancelled import without using up an attempt', () => {
  const fixture = bridgeFixture('dictprop-publisher-cancelled-');
  try {
    const result = fixture.publish({ FAKE_IMPORT_CONCLUSIONS: 'cancelled,cancelled,cancelled,success' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.dispatches(), 4);
    assert.equal(result.stdout.match(/was cancelled; retrying without counting it/g)?.length, 3);
    assert.doesNotMatch(result.stdout, /three fresh workflows/);
    assert.ok(existsSync(join(fixture.stateDir, 'complete')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('publisher gives up at its deadline and deletes the release', () => {
  const fixture = bridgeFixture('dictprop-publisher-deadline-');
  try {
    const result = fixture.publish({
      FAKE_ACTIONS_STATUS: 'major_outage',
      FAKE_REAL_SLEEP: '1',
      PUBLISH_DEADLINE_SECONDS: '1',
    }, '1');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout,
      new RegExp(`import import of ${bridgeTag} was not verified within 1s; giving up and deleting the release`));
    assert.match(fixture.ghLog(), releaseDelete);
    assert.doesNotMatch(fixture.ghLog(), /^workflow run /m);
    assert.ok(existsSync(join(fixture.stateDir, 'failed')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('publisher caps a deadline the release sweep would outlast at five hours', () => {
  const fixture = bridgeFixture('dictprop-publisher-capped-');
  try {
    // Five hours pass between one reading of the clock and the next, so the capped deadline has passed at
    // the first check, and the 24 hours asked for would not have.
    writeExecutable(join(fixture.root, 'bin', 'date'), `#!/bin/sh
if [ "$1" = +%s ]; then
  reads=$(cat "$FAKE_GH_STATE/clock-reads" 2>/dev/null || echo 0)
  echo $((reads + 1)) > "$FAKE_GH_STATE/clock-reads"
  echo $((1800000000 + reads * 18000))
  exit 0
fi
exec /bin/date "$@"
`);
    const result = fixture.publish({ PUBLISH_DEADLINE_SECONDS: '86400' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout,
      /PUBLISH_DEADLINE_SECONDS=86400 would outlast the sweep, which deletes a release idle for six hours; capping it at 18000s/);
    assert.match(result.stdout,
      new RegExp(`import import of ${bridgeTag} was not verified within 18000s; giving up and deleting the release`));
    assert.match(fixture.ghLog(), releaseDelete);
    assert.doesNotMatch(fixture.ghLog(), /^workflow run /m);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a deployment lookup that fails is checked again, never taken to mean there is no deployment', () => {
  const fixture = bridgeFixture('dictprop-publisher-deploy-lookup-');
  try {
    const result = fixture.publish({ FAKE_GH_FAIL: '--commit@1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`could not query the deployment of ${deploySha}; checking again later`));
    assert.doesNotMatch(fixture.ghLog(), /^workflow run deploy\.yml /m);
    assert.equal(fixture.dispatches(), 1);
    assert.ok(existsSync(join(fixture.stateDir, 'complete')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a release that cannot be read is checked again, and the archive is uploaded once', () => {
  const fixture = bridgeFixture('dictprop-publisher-release-read-');
  try {
    // The deployment is still running at the first pass, and the second pass cannot read the release.
    const result = fixture.publish({ FAKE_DEPLOY_STATES: 'in_progress,completed', FAKE_GH_FAIL: 'release view@2' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /waiting for required deployment 100 \(in_progress\)/);
    assert.match(result.stdout, new RegExp(`could not read release ${bridgeTag}; checking again later`));
    assert.equal(fixture.uploads(), 1);
    assert.ok(existsSync(join(fixture.stateDir, 'complete')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a deployment seen to succeed is not looked up again', () => {
  const fixture = bridgeFixture('dictprop-publisher-deploy-once-');
  try {
    const result = fixture.publish({ FAKE_IMPORT_CONCLUSIONS: 'failure,success' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.dispatches(), 2);
    assert.equal(fixture.ghLog().match(/^run list .*--commit /gm)?.length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a deploy SHA that is neither known here nor complete, or a poll interval that is not a number, is refused', () => {
  const fixture = bridgeFixture('dictprop-publisher-arguments-');
  try {
    const short = fixture.publish({}, '0', 'abc1234');
    assert.equal(short.status, 2);
    assert.match(short.stderr, /required-deploy-sha must be a commit this checkout knows or a full 40-character SHA: abc1234/);
    const poll = fixture.publish({}, 'soon');
    assert.equal(poll.status, 2);
    assert.match(poll.stderr, /poll-seconds must be a non-negative integer: soon/);
    assert.equal(fixture.ghLog(), '');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a status page that cannot be read does not hold publication back', () => {
  const fixture = bridgeFixture('dictprop-publisher-status-down-');
  try {
    const result = fixture.publish({ FAKE_STATUS_PAGE: 'down', FAKE_IMPORT_CONCLUSIONS: 'failure,success' });
    assert.equal(result.status, 0, result.stderr);
    // Said once, though the loop passed the check on every round.
    assert.equal(result.stdout.match(/GitHub status unknown \(API=unknown, Actions=unknown\); carrying on/g)?.length, 1);
    assert.doesNotMatch(result.stdout, /GitHub not ready/);
    assert.equal(fixture.dispatches(), 2);
    assert.ok(existsSync(join(fixture.stateDir, 'complete')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
