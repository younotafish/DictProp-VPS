// Preloaded into every test process by both test scripts (`--import`), so no test sees the developer's environment:
// not the repo .env, not the dev server's database, not the real GitHub CLI, repository or bridge key, and not the
// corporate proxy that CI doesn't have. A test that needs one of these values sets its own.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'dictprop-test-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
// Everything temporary, the tests' (os.tmpdir()) and the scripts' (mktemp), lands here and goes with the process.
process.env.TMPDIR = scratch;
process.env.DATA_DIR = join(scratch, 'data');

// dotenv never overrides a variable that is already set, even to '', so the repo .env stays out.
// PORT stays unset: env.ts would read '' as port 0 and throw.
for (const name of ['DEEPINFRA_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OWNER_GOOGLE_EMAIL', 'PUBLIC_ORIGIN']) {
  process.env[name] = '';
}
process.env.DEV_AUTH_BYPASS = '0';
delete process.env.NODE_ENV;

// Scripts under test never reach the real GitHub CLI, repository or bridge key.
process.env.GH_BIN = join(scratch, 'no-gh');
process.env.GITHUB_REPOSITORY = 'invalid/invalid';
process.env.XDG_CONFIG_HOME = join(scratch, 'config');
process.env.SENTENCE_BRIDGE_KEY_FILE = join(scratch, 'no-key');
delete process.env.SENTENCE_BRIDGE_KEY;

// Each test file's process sends its results to the test runner on stdout, and on a loaded machine other lines there,
// such as the client logger's console.log output, can garble that stream ('Unable to deserialize cloned data') after
// every test has passed. Logging goes to stderr instead, which the runner passes through untouched.
console.log = console.info = console.debug = console.error;

// proxy-fetch.ts picks its transport from these when it loads; CI has none, so neither do the tests here.
for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[name];
