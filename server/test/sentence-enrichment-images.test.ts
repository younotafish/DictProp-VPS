import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { enrichmentId } from '../src/example-enrichment-coverage.js';

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { upsertSentenceEnrichment } = await import('../src/db.js');
const { sentenceLookupHash } = await import('../src/sentence-enrichment.js');
const app = createApp({ logging: false, serveStaticFiles: false });

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const text = 'The lucid witness explained everything twice.';
const lookupHash = sentenceLookupHash(text);
const analysis = {
  translation: '清醒的证人把一切解释了两遍。',
  naturalSpeechIpa: '/ðə ˈluːsɪd ˈwɪtnəs ɪkˈspleɪnd ˈɛvriθɪŋ twaɪs/',
  americanEnglish: { status: 'shared' as const, explanation: 'This is natural in American English.' },
  terms: [],
  imagePrompt: 'A realistic photograph of a witness speaking calmly, without text.',
};
const prepare = (image: Buffer, generatedAt: number) => upsertSentenceEnrichment({
  entry: {
    id: enrichmentId(lookupHash), text, lookupHash,
    textHash: createHash('sha256').update(text).digest('hex'), analysis, generatedAt,
  },
  image,
  mimeType: 'image/png',
});
const etagOf = (bytes: Buffer) => `"${createHash('sha256').update(bytes).digest('hex')}"`;

test('a prepared sentence image revalidates by content hash, so a replaced image shows up', async () => {
  const first = Buffer.concat([png, Buffer.from([1])]);
  prepare(first, 10_000);

  const lookup = await app.request('/api/sentence-enrichments/lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  assert.equal(lookup.headers.get('Cache-Control'), null);
  const { imageUrl } = await lookup.json() as { imageUrl: string };
  assert.equal(imageUrl, `/api/sentence-enrichments/${lookupHash}/image`);

  let response = await app.request(imageUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('ETag'), etagOf(first));
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=300, must-revalidate');
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), first);

  response = await app.request(imageUrl, { headers: { 'If-None-Match': etagOf(first) } });
  assert.equal(response.status, 304);

  // A newer wave replaces the image at the same URL.
  const second = Buffer.concat([png, Buffer.from([2])]);
  prepare(second, 20_000);
  response = await app.request(imageUrl, { headers: { 'If-None-Match': etagOf(first) } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('ETag'), etagOf(second));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), second);
});
