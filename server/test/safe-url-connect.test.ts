import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

// The proxy is chosen when the module loads; the connect-time check only applies to direct (VPS) requests.
for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[name];
const { proxyFetch } = await import('../src/proxy-fetch.js');
const { createPublicAddressLookup, fetchPublicHttpUrl, publicAddressLookup } = await import('../src/safe-url.js');

const answering = (...addresses: string[]) => createPublicAddressLookup((_hostname, _options, callback) =>
  callback(null, addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))));

function lookUp(lookup: ReturnType<typeof createPublicAddressLookup>, hostname: string, all: boolean) {
  return new Promise<{ error: NodeJS.ErrnoException | null; result: unknown; family?: number }>(resolve =>
    lookup(hostname, { all }, (error: NodeJS.ErrnoException | null, result: unknown, family?: number) =>
      resolve({ error, result, family })));
}

async function withServer(run: (port: number, requests: () => number) => Promise<void>) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end('reached');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    await run((server.address() as { port: number }).port, () => requests);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('the connection lookup passes public answers through in both of Node\'s callback forms', async () => {
  const lookup = answering('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
  const single = await lookUp(lookup, 'example.com', false);
  assert.equal(single.error, null);
  assert.equal(single.result, '93.184.216.34');
  assert.equal(single.family, 4);
  const all = await lookUp(lookup, 'example.com', true);
  assert.equal(all.error, null);
  assert.deepEqual(all.result, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);
});

test('the connection lookup refuses any private answer, an empty one, and passes resolver errors on', async () => {
  for (const addresses of [['127.0.0.1'], ['93.184.216.34', '10.0.0.5'], ['::ffff:169.254.169.254'], []]) {
    for (const all of [false, true]) {
      const { error } = await lookUp(answering(...addresses), 'rebinding.example', all);
      assert.equal(error?.code, 'ERR_PRIVATE_ADDRESS', addresses.join(','));
    }
  }
  const failing = createPublicAddressLookup((_hostname, _options, callback) =>
    callback(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), []));
  assert.equal((await lookUp(failing, 'missing.example', true)).error?.code, 'ENOTFOUND');
  // The real resolver: localhost resolves, but only to loopback.
  assert.equal((await lookUp(publicAddressLookup, 'localhost', true)).error?.code, 'ERR_PRIVATE_ADDRESS');
});

test('a direct request resolves its host through the given lookup when the socket connects', async () => {
  await withServer(async (port, requests) => {
    const toLoopback = (_hostname: string, options: { all?: boolean }, callback: Function) => {
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    };
    const response = await proxyFetch(`http://dictprop-test.invalid:${port}/`, {}, { lookup: toLoopback as any });
    assert.equal(await response.text(), 'reached');
    assert.equal(requests(), 1);

    // A host that rebinds to a private address after any earlier check is refused before a byte is sent.
    await assert.rejects(
      proxyFetch(`http://rebinding.invalid:${port}/`, {}, { lookup: answering('127.0.0.1') }),
      (error: any) => (error?.cause?.code ?? error?.code) === 'ERR_PRIVATE_ADDRESS',
    );
    assert.equal(requests(), 1);
  });
});

test('redirects are followed by hand, and every hop is checked again', async () => {
  const transportFor = (responses: Record<string, () => Response>) => {
    const calls: Array<{ url: string; init: RequestInit; direct: { lookup: unknown } }> = [];
    const transport = async (url: string, init: RequestInit, direct: { lookup: unknown }) => {
      calls.push({ url, init, direct });
      return (responses[url] ?? (() => new Response('missing', { status: 404 })))();
    };
    return { calls, transport };
  };
  const redirect = (location?: string, status = 302) =>
    () => new Response(null, { status, headers: location ? { Location: location } : {} });

  let { calls, transport } = transportFor({
    'http://8.8.8.8/start': redirect('http://8.8.4.4/next', 301),
    'http://8.8.4.4/next': redirect('/final', 307),
    'http://8.8.4.4/final': () => new Response('image'),
  });
  const response = await fetchPublicHttpUrl('http://8.8.8.8/start', { method: 'GET' }, { transport });
  assert.equal(await response.text(), 'image');
  assert.deepEqual(calls.map(call => call.url), ['http://8.8.8.8/start', 'http://8.8.4.4/next', 'http://8.8.4.4/final']);
  for (const call of calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.direct.lookup, publicAddressLookup);
  }

  for (const [target, message] of [
    ['http://127.0.0.1/admin', /Private address/],
    ['http://[::1]/admin', /Private address/],
    ['http://localhost/admin', /Private host/],
    ['file:///etc/passwd', /public HTTP/],
    ['http://8.8.8.8:2375/containers', /port/],
  ] as const) {
    ({ calls, transport } = transportFor({ 'http://8.8.8.8/start': redirect(target) }));
    await assert.rejects(fetchPublicHttpUrl('http://8.8.8.8/start', {}, { transport }), message, target);
    assert.equal(calls.length, 1, target);
  }

  ({ calls, transport } = transportFor({ 'http://8.8.8.8/start': redirect() }));
  await assert.rejects(fetchPublicHttpUrl('http://8.8.8.8/start', {}, { transport }), /no location/);

  ({ calls, transport } = transportFor({ 'http://8.8.8.8/start': redirect('http://8.8.8.8/start') }));
  await assert.rejects(fetchPublicHttpUrl('http://8.8.8.8/start', {}, { transport }), /Too many redirects/);
  assert.equal(calls.length, 4); // the request and its three allowed redirects
});
