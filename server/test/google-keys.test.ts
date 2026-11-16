import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { createGoogleIdTokenVerifier, GoogleKeysUnavailableError } from '../src/google-auth.js';

const audience = 'dictprop-test-client';
const keyPair = async (kid: string) => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  return { kid, privateKey, jwk: { ...await exportJWK(publicKey), kid, alg: 'RS256', use: 'sig' } };
};
const current = await keyPair('current');
const rotated = await keyPair('rotated');

async function token(key: typeof current, { expiresIn = 300 } = {}): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: 'owner@example.com', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setSubject('google-user')
    .setIssuer('https://accounts.google.com')
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .sign(key.privateKey);
}

/** Google's key endpoint, serving whichever keys and Cache-Control a test sets, and counting its calls. */
function googleKeys(keys: JSONWebKeySet['keys'], cacheControl: string | null = 'public, max-age=60') {
  const endpoint = {
    keys, cacheControl, status: 200, calls: 0, clock: 0,
    fetch: async () => {
      endpoint.calls++;
      if (endpoint.status !== 200) return new Response('unavailable', { status: endpoint.status });
      return Response.json({ keys: endpoint.keys }, endpoint.cacheControl ? { headers: { 'Cache-Control': endpoint.cacheControl } } : {});
    },
  };
  const verifier = createGoogleIdTokenVerifier({ fetch: endpoint.fetch, now: () => endpoint.clock });
  return { endpoint, verify: verifier.verify };
}

test('the keys are cached for the max-age Google sends, and for an hour without one', async () => {
  const { endpoint, verify } = googleKeys([current.jwk]);
  await verify(await token(current), audience);
  await verify(await token(current), audience);
  assert.equal(endpoint.calls, 1);
  endpoint.clock = 60_000;
  await verify(await token(current), audience);
  assert.equal(endpoint.calls, 2);

  for (const cacheControl of [null, 'max-age=0']) {
    const fallback = googleKeys([current.jwk], cacheControl);
    await fallback.verify(await token(current), audience);
    fallback.endpoint.clock = 60 * 60 * 1000 - 1;
    await fallback.verify(await token(current), audience);
    assert.equal(fallback.endpoint.calls, 1, String(cacheControl));
    fallback.endpoint.clock = 60 * 60 * 1000;
    await fallback.verify(await token(current), audience);
    assert.equal(fallback.endpoint.calls, 2, String(cacheControl));
  }
});

test('a token signed with a key the cache lacks fetches the keys once more', async () => {
  const { endpoint, verify } = googleKeys([current.jwk]);
  await verify(await token(current), audience);
  endpoint.keys = [current.jwk, rotated.jwk];
  assert.equal((await verify(await token(rotated), audience)).sub, 'google-user');
  assert.equal(endpoint.calls, 2);

  // When the fresh keys don't have it either, the original failure is the answer.
  const stranger = await keyPair('stranger');
  await assert.rejects(verify(await token(stranger), audience), { name: 'JWKSNoMatchingKey' });
  assert.equal(endpoint.calls, 3);
});

test('a bad token fails at once, without fetching the keys again', async () => {
  const { endpoint, verify } = googleKeys([current.jwk]);
  await assert.rejects(verify(await token(current, { expiresIn: -60 }), audience), { name: 'JWTExpired' });
  await assert.rejects(verify(await token(current), 'another-client'), { name: 'JWTClaimValidationFailed' });
  assert.equal(endpoint.calls, 1);
});

test('keys Google can\'t serve are a GoogleKeysUnavailableError, not a bad token', async () => {
  const { endpoint, verify } = googleKeys([current.jwk]);
  endpoint.status = 503;
  await assert.rejects(verify(await token(current), audience), (error: unknown) =>
    error instanceof GoogleKeysUnavailableError && /503/.test(error.message));

  const unreachable = createGoogleIdTokenVerifier({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  await assert.rejects(unreachable.verify(await token(current), audience), GoogleKeysUnavailableError);

  const empty = createGoogleIdTokenVerifier({ fetch: async () => Response.json({ keys: [] }) });
  await assert.rejects(empty.verify(await token(current), audience), /response is invalid/);
});
