import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeExecutable } from '../../support/fs.ts';
import { block, readWorkflow } from './workflow.ts';

/** ssh runs a remote script in root's login shell on the VPS, which is zsh, so these tests run it there too.
 *  -f leaves out this machine's zsh startup files. A step's run block runs in bash on the runner. */
export const REMOTE_SHELL = ['zsh', '-f'] as const;

export function stub(bin: string, name: string, body: string): void {
  writeExecutable(join(bin, name), `#!/bin/bash\n${body}\n`);
}

/** A clean environment for scripts under test: the stubs first on PATH, and git kept off the user's config. */
export const scriptEnv = (bin: string, variables: Record<string, string>): NodeJS.ProcessEnv => ({
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

export const RUN_ID = '4242';
export const RELEASE_IMAGE = 'ghcr.io/younotafish/dictprop-vps:candidate';

/** deploy.yml's server script in three parts: checkout and exit trap, the .env update, and the release. */
export function deployScript() {
  const script = block(readWorkflow('deploy.yml'), 'script', {
    'github.run_id': RUN_ID,
    'github.run_attempt': '1',
    'github.sha': 'candidate',
  });
  assert.doesNotMatch(script, /\$\{\{/);
  // The stubbed curl answers every health check the same way, so three attempts decide what 120 would: three in
  // a row pass, and a failing release fails all of them. The other 117 only forked stubs.
  assert.ok(script.includes('for attempt in $(seq 1 120); do'), 'wait_for_health makes 120 attempts');
  const lines = script.replace('for attempt in $(seq 1 120); do', 'for attempt in $(seq 1 3); do').split('\n');
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
