import assert from 'node:assert/strict';
import test from 'node:test';

// A deployment whose sign-in returns to an origin other than the canonical one.
process.env.PUBLIC_ORIGIN = 'https://staging.example/';

const { createApp } = await import('../src/app.js');
const { env, parsePublicOrigin } = await import('../src/env.js');
const app = createApp({ logging: false, serveStaticFiles: false });

test('PUBLIC_ORIGIN is read as an origin, and anything but an http(s) URL stops startup', () => {
  assert.equal(env.PUBLIC_ORIGIN, 'https://staging.example');
  assert.equal(parsePublicOrigin(undefined), '');
  assert.equal(parsePublicOrigin(''), '');
  assert.equal(parsePublicOrigin('http://localhost:3001'), 'http://localhost:3001');
  assert.equal(parsePublicOrigin('https://dictprop.online/'), 'https://dictprop.online');
  for (const invalid of ['dictprop.online', 'ftp://dictprop.online', 'javascript:alert(1)']) {
    assert.throws(() => parsePublicOrigin(invalid), /Invalid PUBLIC_ORIGIN/, invalid);
  }
});

test('pages on PUBLIC_ORIGIN can save as the canonical origin\'s can, and other origins still cannot', async () => {
  const logout = (origin: string) => app.request('/api/auth/logout', { method: 'POST', headers: { Origin: origin } });
  for (const origin of ['https://staging.example', 'https://dictprop.online']) {
    const response = await logout(origin);
    assert.equal(response.status, 200, origin);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  }
  const refused = await logout('https://evil.example');
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: 'Cross-origin mutation rejected' });
});

test('sign-in returns to PUBLIC_ORIGIN', async () => {
  const response = await app.request('/api/auth/login');
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('Location')!);
  assert.equal(location.searchParams.get('redirect_uri'), 'https://staging.example/api/auth/callback');
});
