import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateNetworkAddress, resolvePublicHttpUrl } from '../src/safe-url.js';

test('SSRF address checks reject private IPv4, IPv6, and mapped forms', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.20.0.1',
    '192.168.1.1',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }
  assert.equal(isPrivateNetworkAddress('8.8.8.8'), false);
  assert.equal(isPrivateNetworkAddress('2001:4860:4860::8888'), false);
});

test('public URL validation rejects credentials, unusual ports, and literal private targets', async () => {
  await assert.rejects(resolvePublicHttpUrl('http://127.0.0.1/image.png'), /Private address/);
  await assert.rejects(resolvePublicHttpUrl('https://user:pass@8.8.8.8/image.png'), /public HTTP/);
  await assert.rejects(resolvePublicHttpUrl('https://8.8.8.8:8443/image.png'), /port/);
  assert.equal((await resolvePublicHttpUrl('https://8.8.8.8/image.png')).hostname, '8.8.8.8');
});
