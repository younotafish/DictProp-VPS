import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { repoPath } from '../support/paths.ts';
import { deployScript, GNU_STAT, REMOTE_SHELL, scriptEnv, stub } from './support/deploy.ts';

// deploy.yml's database backup, run in zsh as on the VPS against a real SQLite database. docker and df are stood in
// for. The VPS has GNU find and stat, which macOS lacks, so the two forms the script uses are stood in for too.
const hasPython = spawnSync('python3', ['--version']).status === 0;
const skip = !hasPython && 'python3 is not installed';
const HOUR = 60 * 60;
const ROWS = 3_000;
// Counts the steps of a better-sqlite3 backup: its progress callback runs once after each step that leaves pages
// to copy, so a copy taken in one step calls it once. It wraps whatever callback the script under test passes.
const BACKUP_SPY = `
const { writeFileSync } = require('node:fs');
const Database = require(process.env.BETTER_SQLITE3);
const backup = Database.prototype.backup;
Database.prototype.backup = function (filename, options = {}) {
  let steps = 0;
  const progress = info => { steps += 1; return options.progress ? options.progress(info) : undefined; };
  return backup.call(this, filename, { ...options, progress })
    .finally(() => writeFileSync(process.env.BACKUP_SPY_LOG, String(steps)));
};
`;

/** Runs Python with the given program and arguments, and returns what it printed. */
function python(program: string, ...args: string[]): string {
  const result = spawnSync('python3', ['-c', program, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const createDatabase = (path: string): void => {
  python(`import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode=WAL")
db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT)")
db.executemany("INSERT INTO items (text) VALUES (?)", [("row %d " % i * 40,) for i in range(${ROWS})])
db.commit()
db.close()`, path);
};

/** Runs one query on a database, read without leaving -wal or -shm files beside it. */
const query = (path: string, sql: string): number => Number(python(`import sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro&immutable=1", uri=True)
print(db.execute(sys.argv[2]).fetchone()[0])`, path, sql));
const rowsIn = (path: string): number => query(path, 'SELECT COUNT(*) FROM items');

/** /opt/dictprop-vps with a data folder and the stubs on PATH. */
function makeDeployDir() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-backup-'));
  const app = join(dir, 'app');
  const bin = join(dir, 'bin');
  const backups = join(app, 'data', 'backups');
  mkdirSync(backups, { recursive: true });
  mkdirSync(bin);
  const calls = join(dir, 'calls.log');
  const spy = join(dir, 'backup-spy.cjs');
  const spyLog = join(dir, 'backup-steps');
  writeFileSync(spy, BACKUP_SPY);

  // The online copy runs the script exactly as the container would, with its paths moved to this checkout.
  stub(bin, 'docker', String.raw`
case "$1 $2" in
  'compose ps') [ -n "$NO_CONTAINER" ] || echo app-container ;;
  'compose exec')
    shift 2
    while [ "$1" != app ]; do
      if [ "$1" = -e ]; then backup_path="$(printf '%s' "$2" | sed 's#^BACKUP_PATH=/app/data/#data/#')"; shift; fi
      shift
    done
    shift
    echo "docker compose exec $backup_path" >> "$CALLS"
    [ "$1 $2" = 'node -e' ] || { echo "unexpected docker compose exec $*" >&2; exit 97; }
    # A copy that fails partway can leave its partial file behind.
    [ -z "$FAIL_EXEC" ] || { echo partial > "$backup_path"; exit 1; }
    script="$(printf '%s' "$3" | sed -e "s#/app/server/node_modules/better-sqlite3#$BETTER_SQLITE3#g" -e "s#/app/data/#$PWD/data/#g")"
    BACKUP_PATH="$PWD/$backup_path" exec "$NODE" --require "$BACKUP_SPY" -e "$script" ;;
  'inspect --format')
    [ "$3 $4" = '{{.State.Running}}/{{.State.Restarting}} app-container' ] || { echo "unexpected docker $*" >&2; exit 97; }
    echo "$FAKE_APP_STATE" ;;
  'system df') ;;
  *) echo "unexpected docker $*" >&2; exit 97 ;;
esac`);
  stub(bin, 'df', String.raw`
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda2 61000000 1000 %s 1%% /\n' "$FAKE_AVAILABLE_KB"`);
  stub(bin, 'python3', String.raw`
echo python3 >> "$CALLS"
PATH="$REAL_PATH" exec python3 "$@"`);
  stub(bin, 'stat', GNU_STAT);
  // find DIR -maxdepth 1 -type f \( -name GLOB -o -name GLOB \) -printf '%T@ %p\n'; every other form is the real find.
  stub(bin, 'find', String.raw`
for arg in "$@"; do
  [ "$arg" = -printf ] && exec perl -MTime::HiRes -e '
    my ($dir, @rest) = @ARGV;
    my (@globs, $format);
    while (@rest) {
      my $arg = shift @rest;
      if ($arg eq "-name") { push @globs, shift @rest }
      elsif ($arg eq "-printf") { $format = shift @rest }
      elsif ($arg eq "-maxdepth" || $arg eq "-type") {
        my $value = shift @rest;
        die "unexpected find $arg $value\n" unless "$arg $value" eq "-maxdepth 1" || "$arg $value" eq "-type f";
      }
      elsif ($arg ne "(" && $arg ne ")" && $arg ne "-o") { die "unexpected find argument $arg\n" }
    }
    die "unexpected find format $format\n" unless $format eq q{%T@ %p\n};
    opendir(my $handle, $dir) or exit 0;
    for my $entry (sort readdir $handle) {
      my $path = "$dir/$entry";
      next if -l $path || !-f $path;
      next unless grep { my $glob = quotemeta; $glob =~ s/\\\*/.*/g; $entry =~ /^$glob$/ } @globs;
      printf "%.10f %s\n", (Time::HiRes::stat($path))[9], $path;
    }
  ' -- "$@"
done
PATH="$REAL_PATH" exec find "$@"`);

  /** Writes a file under data/backups, last modified the given number of hours ago. */
  const copy = (name: string, hoursAgo: number, contents = 'copy'): string => {
    const path = join(backups, name);
    writeFileSync(path, contents);
    const at = Date.now() / 1000 - hoursAgo * HOUR;
    utimesSync(path, at, at);
    return path;
  };

  const run = (variables: Record<string, string> = {}) => {
    const result = spawnSync(REMOTE_SHELL[0], [...REMOTE_SHELL.slice(1), '-c', `set -e\ncd "$DEPLOY_DIR"\n${deployScript().backup}\n`], {
      cwd: app,
      encoding: 'utf8',
      env: scriptEnv(bin, {
        DEPLOY_DIR: app,
        CALLS: calls,
        REAL_PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE: process.execPath,
        BETTER_SQLITE3: repoPath('server/node_modules/better-sqlite3'),
        BACKUP_SPY: spy,
        BACKUP_SPY_LOG: spyLog,
        FAKE_AVAILABLE_KB: '50000000',
        FAKE_APP_STATE: 'true/false',
        ...variables,
      }),
    });
    const logged = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [];
    rmSync(calls, { force: true });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: logged };
  };

  return {
    app,
    backups,
    database: join(app, 'data', 'dictprop.db'),
    copy,
    run,
    listing: () => readdirSync(backups).sort(),
    /** How many steps the online copy took. */
    onlineSteps: () => Number(readFileSync(spyLog, 'utf8')),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const FRESH_COPY = /^dictprop-\d{8}T\d{6}Z-candidate\.db$/;

test('a copy younger than twelve hours is reused as it is, and the older copies and leftovers go', { skip }, () => {
  const server = makeDeployDir();
  try {
    createDatabase(server.database);
    const young = 'pre-sentence-enrichments-20261115T060000Z.db';
    server.copy(young, 1);
    server.copy(`${young}.verified`, 1);
    const old = 'dictprop-20261114T000000Z-0123abc.db';
    for (const suffix of ['', '-wal', '-shm', '.verified']) server.copy(`${old}${suffix}`, 20);
    server.copy('dictprop-20261115T050000Z-abc.db.partial', 2);

    const run = server.run();
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, new RegExp(`Reusing backup data/backups/${young.replaceAll('.', '\\.')} from \\d+s ago`));
    // Nothing reads the copy or writes a new one: no check, no online copy and no host copy.
    assert.deepEqual(run.calls, []);
    assert.deepEqual(server.listing(), [young]);
  } finally {
    server.remove();
  }
});

test('an older copy is replaced by one fresh copy of the database, taken from the running container in one step', { skip }, () => {
  const server = makeDeployDir();
  try {
    createDatabase(server.database);
    // Big enough that better-sqlite3's default of 100 pages a step would take several.
    assert.ok(query(server.database, 'PRAGMA page_count') > 200);
    const old = 'pre-offline-images-20261114T000000Z.db';
    for (const suffix of ['', '-wal', '-shm']) server.copy(`${old}${suffix}`, 13);

    const run = server.run();
    assert.equal(run.status, 0, run.output);
    const [fresh, ...rest] = server.listing();
    assert.match(fresh, FRESH_COPY);
    assert.deepEqual(rest, [], 'the old copy goes with its -wal and -shm files');
    assert.deepEqual(run.calls, [`docker compose exec data/backups/${fresh}.partial`]);
    assert.equal(rowsIn(join(server.backups, fresh)), ROWS);
    // Each step after the first restarts the copy if the live server commits in between.
    assert.equal(server.onlineSteps(), 1);
  } finally {
    server.remove();
  }
});

test('with no container to copy from, the host copies the database', { skip }, () => {
  const server = makeDeployDir();
  try {
    createDatabase(server.database);
    const run = server.run({ NO_CONTAINER: '1' });
    assert.equal(run.status, 0, run.output);
    const [fresh, ...rest] = server.listing();
    assert.match(fresh, FRESH_COPY);
    assert.deepEqual(rest, []);
    assert.deepEqual(run.calls, ['python3']);
    assert.equal(rowsIn(join(server.backups, fresh)), ROWS);
  } finally {
    server.remove();
  }
});

test('a backup that would not fit is refused before anything is written, and the older copy stays', { skip }, () => {
  const server = makeDeployDir();
  try {
    createDatabase(server.database);
    const old = 'dictprop-20261114T000000Z-0123abc.db';
    server.copy(old, 13);
    const run = server.run({ FAKE_AVAILABLE_KB: '1000' });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /::error::Not deploying: a database backup needs \d+KB free and 1000KB are/);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(server.listing(), [old]);
  } finally {
    server.remove();
  }
});

test('without a database there is nothing to back up', { skip }, () => {
  const server = makeDeployDir();
  try {
    server.copy('dictprop-20261114T000000Z-0123abc.db', 13);
    const run = server.run();
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(server.listing(), ['dictprop-20261114T000000Z-0123abc.db']);
  } finally {
    server.remove();
  }
});

// A crash-looping app is listed as running but refuses exec, and the deploy that ships its fix must still get its copy.
test('a restarting app, or an online copy that fails, leaves the copy to the host', { skip }, () => {
  for (const [label, variables, calls] of [
    ['restarting', { FAKE_APP_STATE: 'true/true' }, ['python3']],
    ['paused or stopping', { FAKE_APP_STATE: 'false/false' }, ['python3']],
    ['the online copy failed', { FAIL_EXEC: '1' }, ['docker compose exec', 'python3']],
  ] as const) {
    const server = makeDeployDir();
    try {
      createDatabase(server.database);
      const run = server.run(variables);
      assert.equal(run.status, 0, `${label}: ${run.output}`);
      const [fresh, ...rest] = server.listing();
      assert.match(fresh, FRESH_COPY, label);
      assert.deepEqual(rest, [], `${label}: no partial copy is left behind`);
      assert.deepEqual(run.calls.map(call => call.replace(/ data\/backups\/.*$/, '')), calls, label);
      assert.equal(rowsIn(join(server.backups, fresh)), ROWS, label);
    } finally {
      server.remove();
    }
  }
});
