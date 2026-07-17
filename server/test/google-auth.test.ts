import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { verifyGoogleIdTokenWithJwks } from '../src/google-auth.js';

const audience = 'dictprop-test-client';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = await exportJWK(publicKey);
const jwks: JSONWebKeySet = {
  keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
};

async function token(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: 'learner@example.com',
    email_verified: true,
    name: 'Learner',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('google-user-1')
    .setIssuer('https://accounts.google.com')
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

test('Google identity verification checks the signature and required claims', async () => {
  const identity = await verifyGoogleIdTokenWithJwks(await token(), audience, jwks);
  assert.equal(identity.sub, 'google-user-1');
  assert.equal(identity.email, 'learner@example.com');

  await assert.rejects(
    verifyGoogleIdTokenWithJwks(await token(), 'another-client', jwks),
    /aud/,
  );
  await assert.rejects(
    verifyGoogleIdTokenWithJwks(await token({ email_verified: false }), audience, jwks),
    /identity claims/,
  );
});
