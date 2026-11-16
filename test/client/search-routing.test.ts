import assert from 'node:assert/strict';
import test from 'node:test';
import { routeLookup, type LookupFacts, type LookupRoute } from '../../components/search/searchRouting.ts';
import type { LookupRequest } from '../../services/searchRequests.ts';

const online: LookupFacts = { online: true, saved: false, sentence: false };
const route = (source: LookupRequest['source'], facts: Partial<LookupFacts> = {}, forceAI?: boolean): LookupRoute =>
  routeLookup({ source, forceAI }, { ...online, ...facts });

const ANALYZE: LookupRoute = { kind: 'analyze', forceAI: false };
const BATCH: LookupRoute = { kind: 'analyze', analyzeMode: 'batch', forceAI: false };
const REFRESH: LookupRoute = { kind: 'analyze', forceAI: true };

test('a word or a short phrase is analyzed as it is, typed or picked on screen', () => {
  for (const source of ['text', 'expression'] as const) {
    assert.deepEqual(route(source), ANALYZE, source);
    assert.deepEqual(route(source, { saved: true }), ANALYZE, `${source}, saved: the library answers it first`);
  }
});

test('a typed sentence is scanned, and a sentence picked on screen is one expression', () => {
  assert.deepEqual(route('text', { sentence: true }), { kind: 'scan' });
  assert.deepEqual(route('expression', { sentence: true }), BATCH);
  assert.deepEqual(route('expression', { sentence: true, saved: true }), BATCH);
});

test('a refresh always asks the AI, whatever it reads like, even offline', () => {
  for (const source of ['text', 'expression'] as const) {
    for (const facts of [{}, { sentence: true }, { saved: true }, { online: false }, { online: false, sentence: true, saved: true }]) {
      assert.deepEqual(route(source, facts, true), REFRESH, `${source} ${JSON.stringify(facts)}`);
    }
  }
});

test('offline, a saved word or expression still opens; anything that needs the network is refused', () => {
  const offline = { online: false };
  assert.deepEqual(route('text', { ...offline, saved: true }), ANALYZE);
  assert.deepEqual(route('expression', { ...offline, saved: true }), ANALYZE);
  assert.deepEqual(route('expression', { ...offline, saved: true, sentence: true }), BATCH, 'a saved long expression');
  assert.deepEqual(route('text', offline), { kind: 'offline' });
  assert.deepEqual(route('expression', offline), { kind: 'offline' });
  assert.deepEqual(route('expression', { ...offline, sentence: true }), { kind: 'offline' });
  assert.deepEqual(route('text', { ...offline, sentence: true }), { kind: 'offline' }, 'a scan always needs the network');
  assert.deepEqual(route('text', { ...offline, sentence: true, saved: true }), { kind: 'offline' });
});
