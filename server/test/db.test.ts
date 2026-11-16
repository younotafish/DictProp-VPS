import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { exampleSentenceId } from '../src/sentence-lookup.js';

const { getItemById, getItemsAfterRevision, upsertItem, softDeleteItem, touchItemRevisions, applyReviewEvent, undoReviewEvent, getReviewEvents, upsertItemImageBinary, upsertSentenceEnrichment, getSentenceEnrichmentCount, getSentenceEnrichmentForText, createUserAndClaimItems, createSession, getSession, getSessionUser, extendSession, deleteSession, db } = await import('../src/db.js');
const { sentenceLookupHash } = await import('../src/sentence-enrichment.js');

const makeItem = (
  id: string,
  definition: string,
  updatedAt: number,
  lastReviewDate: number,
  totalReviews: number,
) => ({
  type: 'vocab',
  data: {
    id,
    word: 'test',
    definition,
    chinese: '',
    ipa: '',
    synonyms: [],
    antonyms: [],
    confusables: [],
    examples: [],
    history: '',
    register: '',
    mnemonic: '',
  },
  srs: {
    id,
    type: 'vocab',
    nextReview: lastReviewDate + 86_400_000,
    interval: 1440,
    memoryStrength: 10,
    lastReviewDate,
    lastExposureDate: 0,
    totalReviews,
    correctStreak: totalReviews,
    stability: 1,
  },
  savedAt: 1,
  updatedAt,
});

test('content and SRS resolve conflicts using independent clocks', () => {
  const id = 'conflict-item';
  upsertItem(makeItem(id, 'original', 2_000, 2_000, 2), 'user-a');

  // A newer edit loaded old study progress: accept its content, retain newer SRS.
  upsertItem(makeItem(id, 'new content', 3_000, 1_000, 1), 'user-a');
  let stored = getItemById(id, 'user-a');
  assert.ok(stored);
  assert.equal(stored.data.definition, 'new content');
  assert.equal(stored.srs.lastReviewDate, 2_000);
  assert.equal(stored.srs.totalReviews, 2);

  // A delayed request carries a newer review: retain content, accept its SRS.
  upsertItem(makeItem(id, 'stale content', 1_500, 4_000, 3), 'user-a');
  stored = getItemById(id, 'user-a');
  assert.ok(stored);
  assert.equal(stored.data.definition, 'new content');
  assert.equal(stored.srs.lastReviewDate, 4_000);
  assert.equal(stored.srs.totalReviews, 3);
});

test('passive exposure has an independent conflict clock and preserves review progress', () => {
  const id = 'exposure-conflict-item';
  const original = makeItem(id, 'original', 2_000, 2_000, 2);
  original.srs.lastExposureDate = 3_000;
  upsertItem(original, 'exposure-user');

  const newerExposureWithOldReview = makeItem(id, 'new content', 4_000, 1_000, 1);
  newerExposureWithOldReview.srs.lastExposureDate = 5_000;
  upsertItem(newerExposureWithOldReview, 'exposure-user');
  let stored = getItemById(id, 'exposure-user');
  assert.ok(stored);
  assert.equal(stored.srs.lastReviewDate, 2_000);
  assert.equal(stored.srs.totalReviews, 2);
  assert.equal(stored.srs.lastExposureDate, 5_000);

  const newerReviewWithOldExposure = makeItem(id, 'latest content', 6_000, 6_000, 3);
  newerReviewWithOldExposure.srs.lastExposureDate = 4_000;
  upsertItem(newerReviewWithOldExposure, 'exposure-user');
  stored = getItemById(id, 'exposure-user');
  assert.ok(stored);
  assert.equal(stored.srs.lastReviewDate, 6_000);
  assert.equal(stored.srs.totalReviews, 3);
  assert.equal(stored.srs.lastExposureDate, 5_000);
});

test('item ids cannot overwrite another user', () => {
  const id = 'owned-item';
  upsertItem(makeItem(id, 'owner data', 1_000, 1_000, 1), 'user-a');
  assert.throws(
    () => upsertItem(makeItem(id, 'attacker data', 2_000, 2_000, 2), 'user-b'),
    /belongs to another user/,
  );
  assert.equal(getItemById(id, 'user-a')?.data.definition, 'owner data');
  assert.equal(getItemById(id, 'user-b'), null);
});

test('legacy project tags cannot split the unified library again', () => {
  const item = { ...makeItem('legacy-project-item', 'unified', 1_000, 0, 0), project: 'old-project' };
  upsertItem(item, 'project-user');
  const stored = getItemById('legacy-project-item', 'project-user');
  assert.ok(stored);
  assert.equal((stored as { project?: unknown }).project, undefined);
  const row = db.prepare('SELECT project FROM items WHERE id = ?').get('legacy-project-item') as { project: string | null };
  assert.equal(row.project, null);
});

test('image ids cannot overwrite another user', () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const blobs = () => (db.prepare('SELECT COUNT(*) AS count FROM image_blobs').get() as { count: number }).count;
  const blobsBefore = blobs();
  assert.equal(upsertItemImageBinary('owned-image', image, 'image/png', 'user-a'), true);
  assert.equal(upsertItemImageBinary('owned-image', image, 'image/png', 'user-b'), false);
  assert.equal(upsertItemImageBinary('duplicate-image', image, 'image/png', 'user-a'), true);
  assert.equal(blobs(), blobsBefore + 1);
  const replacement = Buffer.concat([image, Buffer.from([0])]);
  assert.equal(upsertItemImageBinary('owned-image', replacement, 'image/png', 'user-a'), true);
  assert.equal(blobs(), blobsBefore + 2);
  assert.equal(upsertItemImageBinary('duplicate-image', replacement, 'image/png', 'user-a'), true);
  assert.equal(blobs(), blobsBefore + 1);
  assert.equal(upsertItemImageBinary('fake-image', Buffer.from('not an image'), 'image/png', 'user-a'), false);
});

test('stripped image markers change when image content is replaced', () => {
  const id = 'versioned-image-item';
  const userId = 'versioned-image-user';
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  upsertItem(makeItem(id, 'versioned image', 1_000, 0, 0), userId);
  assert.equal(upsertItemImageBinary(id, image, 'image/png', userId), true);
  const firstMarker = getItemById(id, userId, false)?.data.imageUrl;
  assert.match(String(firstMarker), /^server:has_image:[a-f0-9]{20}$/);

  assert.equal(upsertItemImageBinary(id, Buffer.concat([image, Buffer.from([0])]), 'image/png', userId), true);
  const secondMarker = getItemById(id, userId, false)?.data.imageUrl;
  assert.match(String(secondMarker), /^server:has_image:[a-f0-9]{20}$/);
  assert.notEqual(secondMarker, firstMarker);
});

test('saving a prepared example sentence attaches its analysis and deduplicated image', () => {
  const text = 'She finally [[came clean]] about the mistake.';
  const lookupHash = sentenceLookupHash(text);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const analysis = {
    translation: '她终于坦白了那个错误。',
    naturalSpeechIpa: '/ʃi ˈfaɪnəli keɪm kliːn əˈbaʊt ðə mɪˈsteɪk/',
    americanEnglish: { status: 'shared' as const, explanation: 'This is natural in American English.' },
    terms: [],
    imagePrompt: 'A realistic photograph of a candid conversation in a kitchen, without text.',
  };
  const generatedAt = 10_000;
  const blobsBefore = (db.prepare('SELECT COUNT(*) AS count FROM image_blobs').get() as { count: number }).count;
  const enrichmentsBefore = getSentenceEnrichmentCount();
  assert.deepEqual(upsertSentenceEnrichment({
    entry: {
      id: exampleSentenceId(lookupHash),
      text,
      lookupHash,
      textHash: createHash('sha256').update(text).digest('hex'),
      analysis,
      generatedAt,
    },
    image,
    mimeType: 'image/png',
  }), { status: 'inserted', blobAdded: true });
  assert.equal(getSentenceEnrichmentCount(), enrichmentsBefore + 1);

  const sentence = {
    type: 'sentence',
    data: { id: 'prepared-sentence', text: 'She finally came clean about the mistake.', sourceWord: 'come clean' },
    srs: {
      id: 'prepared-sentence', type: 'sentence', nextReview: 0, interval: 0, memoryStrength: 0,
      lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0,
    },
    savedAt: 1,
    updatedAt: 1,
  };
  upsertItem(sentence, 'enrichment-user');
  const stored = getItemById('prepared-sentence', 'enrichment-user', false);
  assert.deepEqual(stored?.data.analysis, analysis);
  assert.equal(stored?.data.analysisGeneratedAt, generatedAt);
  assert.match(String(stored?.data.imageUrl), /^server:has_image:[a-f0-9]{20}$/);

  // A second saved identity links to the same blob instead of storing the image bytes twice.
  upsertItem({
    ...sentence,
    data: { ...sentence.data, id: 'prepared-sentence-copy' },
    srs: { ...sentence.srs, id: 'prepared-sentence-copy' },
  }, 'enrichment-user');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM image_blobs').get() as { count: number }).count, blobsBefore + 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM item_images WHERE user_id = ?').get('enrichment-user') as { count: number }).count, 2);
});

test('a late image repairs media without replacing a complete sentence analysis', () => {
  const text = 'A late image should not overwrite newer analysis.';
  const lookupHash = sentenceLookupHash(text);
  const image = Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    Buffer.from('late-image'),
  ]);
  const identity = {
    id: exampleSentenceId(lookupHash),
    text,
    lookupHash,
    textHash: createHash('sha256').update(text).digest('hex'),
  };
  const newerAnalysis = {
    translation: 'newer',
    naturalSpeechIpa: '/ə ˈleɪt ˈɪmɪdʒ/',
    americanEnglish: {
      status: 'shared' as const,
      explanation: 'Newer analysis.',
      evidence: ['The sentence is natural.'],
    },
    terms: [],
    pronunciation: {
      slowIpa: '/ə ˈleɪt ˈɪmɪdʒ/',
      fastIpa: '/ə ˈleɪt ˈɪmɪdʒ/',
      carefulSpeakerGuide: 'a LATE IM-age',
      fastSpeechFeatures: ['The article is reduced.'],
      intonationAndChunking: 'A late image ↘',
      keyDifference: 'Fluent speech reduces the article.',
    },
    grammar: { structure: 'A noun phrase.', points: [] },
    imagePrompt: 'newer prompt',
  };
  const staleAnalysis = {
    translation: 'stale',
    americanEnglish: { status: 'shared' as const, explanation: 'Stale analysis.' },
    terms: [],
    imagePrompt: 'stale prompt',
  };

  assert.deepEqual(upsertSentenceEnrichment({
    entry: { ...identity, analysis: newerAnalysis, generatedAt: 20_000 },
  }), { status: 'inserted', blobAdded: false });
  assert.deepEqual(upsertSentenceEnrichment({
    entry: { ...identity, analysis: staleAnalysis, generatedAt: 20_000 },
    image,
    mimeType: 'image/png',
  }), { status: 'updated', blobAdded: true });

  const stored = getSentenceEnrichmentForText(text);
  assert.deepEqual(stored?.analysis, newerAnalysis);
  assert.equal(stored?.generatedAt, 20_000);
  assert.ok(stored?.imageContentHash);
});

test('server revisions reject stale content independently of device clocks', () => {
  const id = 'revision-item';
  const revision = upsertItem(makeItem(id, 'current', 2_000, 0, 0), 'user-a').revision;
  const stale = { ...makeItem(id, 'stale but future clock', 99_999, 0, 0), serverRevision: revision - 1 };
  assert.deepEqual(upsertItem(stale, 'user-a'), { revision, conflicted: true });
  const stored = getItemById(id, 'user-a');
  assert.ok(stored);
  assert.equal(stored.data.definition, 'current');
  assert.equal(stored.updatedAt, 2_000);
});

test('review events are idempotent and user scoped', () => {
  upsertItem(makeItem('review-scope-item', 'reviewed once', 1_000, 0, 0), 'user-a');
  const event = {
    id: 'review-1', itemId: 'review-scope-item', itemType: 'vocab' as const,
    reviewedAt: 5_000, previousStep: 0, nextStep: 1, rating: 'good' as const,
  };
  assert.equal(applyReviewEvent(event, [event.itemId], 'user-a')?.applied, true);
  assert.equal(applyReviewEvent(event, [event.itemId], 'user-a')?.applied, false);
  assert.deepEqual(getReviewEvents('user-a', 0), [event]);
  assert.deepEqual(getReviewEvents('user-b', 0), []);
});

test('concurrent review events advance authoritative item progress exactly once each', () => {
  const id = 'atomic-review-item';
  upsertItem(makeItem(id, 'review me', 10_000, 0, 0), 'review-user');
  const first = {
    id: 'atomic-review-1', itemId: id, itemType: 'vocab' as const,
    reviewedAt: 20_000, previousStep: 0, nextStep: 1,
  };
  const second = { ...first, id: 'atomic-review-2', reviewedAt: 20_001 };

  assert.equal(applyReviewEvent(first, [id], 'review-user')?.applied, true);
  assert.equal(applyReviewEvent(second, [id], 'review-user')?.applied, true);
  assert.equal(applyReviewEvent(first, [id], 'review-user')?.applied, false);
  assert.equal(getItemById(id, 'review-user')?.srs.totalReviews, 2);
  assert.deepEqual(
    getReviewEvents('review-user', 0).map(event => [event.previousStep, event.nextStep]),
    [[0, 1], [1, 2]],
  );

  assert.throws(
    () => undoReviewEvent(first.id, 'review-user'),
    /no longer the latest change/,
  );
  assert.equal(undoReviewEvent(second.id, 'review-user')?.undone, true);
  assert.equal(getItemById(id, 'review-user')?.srs.totalReviews, 1);
  assert.deepEqual(getReviewEvents('review-user', 0).map(event => event.id), [first.id]);
  assert.equal(undoReviewEvent(second.id, 'review-user')?.undone, false);
  assert.equal(undoReviewEvent(first.id, 'review-user')?.undone, true);
  assert.equal(getItemById(id, 'review-user')?.srs.totalReviews, 0);
  assert.deepEqual(getReviewEvents('review-user', 0), []);
});

test('a review with a seed brings back a deleted catalog record as the reviewing device seeds it; other deleted items stay deleted', () => {
  const userId = 'catalog-revival-user';
  const record = (id: string, totalReviews: number, lastReviewDate: number) => ({
    type: 'sentence',
    data: {
      id, text: 'Could we {{pressure-test}} that assumption?', sourceWord: 'pressure-test',
      catalogSentenceId: id.slice(id.indexOf(':') + 1), catalogCollectionId: 'collection',
    },
    srs: {
      id, type: 'sentence', nextReview: lastReviewDate, interval: 0, memoryStrength: 0, lastReviewDate, totalReviews,
      correctStreak: totalReviews, stability: 0.5,
    },
    savedAt: 1,
    updatedAt: 1,
  });
  const review = (id: string, itemId: string) => ({
    id, itemId, itemType: 'sentence' as const, reviewedAt: Date.now(), previousStep: 0, nextStep: 1, rating: 'good' as const,
  });

  for (const id of ['real-life-sentence:collection:01', 'essay-sentence:essay:01']) {
    // Reviewed three times, then deleted by a device whose clock runs an hour ahead of the server's.
    upsertItem(record(id, 3, 5_000), userId);
    upsertItem({ ...record(id, 3, 5_000), isDeleted: true, updatedAt: Date.now() + 3_600_000 }, userId);
    assert.equal(applyReviewEvent(review(`${id} unseeded`, id), [id], userId), null);

    // The line shows in its catalog as never reviewed, so the device reviews a new record and sends it as the seed.
    const revived = applyReviewEvent(review(`${id} seeded`, id), [id], userId, record(id, 0, 0));
    assert.equal(revived?.applied, true);
    assert.equal(revived.event.previousStep, 0);
    assert.equal(revived.items[0].isDeleted, undefined);
    assert.equal(revived.items[0].srs.totalReviews, 1);
    // The seed was the device's own copy, which holds no revision yet.
    assert.deepEqual(revived.baseRevisions, { [id]: 0 });

    // Back, it is an ordinary record again: a later seed changes nothing, and the review counts on top.
    assert.equal(applyReviewEvent(review(`${id} again`, id), [id], userId, record(id, 0, 0))?.items[0].srs.totalReviews, 2);
  }

  const ordinary = 'ordinary-sentence';
  upsertItem(record(ordinary, 3, 5_000), userId);
  upsertItem({ ...record(ordinary, 3, 5_000), isDeleted: true, updatedAt: 2 }, userId);
  assert.equal(applyReviewEvent(review('ordinary seeded', ordinary), [ordinary], userId, record(ordinary, 0, 0)), null);
  assert.equal(getItemById(ordinary, userId)?.isDeleted, true);
  assert.equal(getItemById(ordinary, userId)?.srs.totalReviews, 3);
});

test('a retried review changes nothing, so a catalog record deleted after its first attempt stays deleted', () => {
  const userId = 'catalog-retry-user';
  const id = 'real-life-sentence:collection:02';
  const seed = {
    type: 'sentence',
    data: {
      id, text: 'Let us {{circle back}} on that.', sourceWord: 'circle back',
      catalogSentenceId: 'collection:02', catalogCollectionId: 'collection',
    },
    srs: {
      id, type: 'sentence', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0,
      correctStreak: 0, stability: 0.5,
    },
    savedAt: 1,
    updatedAt: 1,
  };
  const review = {
    id: 'catalog-retry-review', itemId: id, itemType: 'sentence' as const, reviewedAt: Date.now(),
    previousStep: 0, nextStep: 1, rating: 'good' as const,
  };

  // The first attempt seeds the record and counts, but its reply is lost, so the review stays in the outbox.
  assert.equal(applyReviewEvent(review, [id], userId, seed)?.applied, true);
  assert.equal(softDeleteItem(id, userId), true);
  const deleted = getItemById(id, userId, false);
  assert.equal(deleted?.isDeleted, true);

  const retried = applyReviewEvent(review, [id], userId, seed);
  assert.equal(retried?.applied, false);
  assert.deepEqual(retried.baseRevisions, {});
  const stored = getItemById(id, userId, false);
  assert.equal(stored?.isDeleted, true);
  assert.equal(stored?.srs.totalReviews, 1);
  assert.equal(stored?.serverRevision, deleted?.serverRevision);
  assert.deepEqual(getReviewEvents(userId, 0).map(event => event.id), [review.id]);
});

test('revision cursor returns every row when revisions are tied', () => {
  upsertItem(makeItem('cursor-a', 'a', 1, 0, 0), 'cursor-user');
  upsertItem(makeItem('cursor-b', 'b', 1, 0, 0), 'cursor-user');
  const revision = 999_999;
  db.prepare(`UPDATE items SET revision = ? WHERE user_id = ?`).run(revision, 'cursor-user');

  const first = getItemsAfterRevision({ revision: 0, id: '' }, 1, 'cursor-user');
  const second = getItemsAfterRevision(first.cursor, 1, 'cursor-user');
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].data.id, second.items[0].data.id);
});

test('revision pages report the newest revision the server has issued', () => {
  upsertItem(makeItem('head-a', 'a', 1, 0, 0), 'head-user');
  upsertItem(makeItem('head-b', 'b', 1, 0, 0), 'head-user');
  const page = getItemsAfterRevision({ revision: 0, id: '' }, 500, 'head-user');
  const issued = db.prepare(`SELECT value FROM sync_meta WHERE key = 'item_revision'`).get() as { value: number };
  assert.equal(page.headRevision, issued.value);
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every(item => item.serverRevision !== undefined && item.serverRevision <= page.headRevision));
});

test('storing an image bumps the revision of every item that shows it', () => {
  const userId = 'touch-user';
  const phrase = (id: string, data: Record<string, unknown>) =>
    ({ ...makeItem(id, '', 1, 0, 0), type: 'phrase', data: { id, query: id, ...data } });
  upsertItem(makeItem('touch-card', 'card', 1, 0, 0), userId);
  upsertItem(makeItem('touch-other', 'other', 1, 0, 0), userId);
  upsertItem(phrase('touch-phrase', { vocabs: [{ id: 'touch-vocab', word: 'vocab' }] }), userId);
  // Names the id outside its vocabs, so it passes the text prefilter but shows no such image.
  upsertItem(phrase('touch-decoy', { vocabs: [], terms: [{ id: 'touch-vocab' }] }), userId);
  const revisionOf = (id: string) =>
    (db.prepare('SELECT revision FROM items WHERE id = ? AND user_id = ?').get(id, userId) as { revision: number }).revision;
  const ids = ['touch-card', 'touch-other', 'touch-phrase', 'touch-decoy'];
  const before = new Map(ids.map(id => [id, revisionOf(id)]));

  touchItemRevisions(['touch-card', 'touch-vocab'], userId);
  assert.ok(revisionOf('touch-card') > before.get('touch-card')!);
  assert.ok(revisionOf('touch-phrase') > before.get('touch-phrase')!);
  assert.equal(revisionOf('touch-other'), before.get('touch-other'));
  assert.equal(revisionOf('touch-decoy'), before.get('touch-decoy'));
  // Another user's copy of the id is untouched.
  upsertItem(makeItem('touch-foreign', 'foreign', 1, 0, 0), 'touch-other-user');
  const foreign = (db.prepare('SELECT revision FROM items WHERE id = ?').get('touch-foreign') as { revision: number }).revision;
  touchItemRevisions(['touch-foreign'], userId);
  assert.equal((db.prepare('SELECT revision FROM items WHERE id = ?').get('touch-foreign') as { revision: number }).revision, foreign);
});

test('session bearer tokens are hashed at rest and remain revocable', () => {
  const user = createUserAndClaimItems({
    googleId: 'session-google-id',
    email: 'session@example.com',
    displayName: 'Session Test',
    photoUrl: null,
  });
  const session = createSession(user.id);
  const stored = db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(user.id) as { token: string };
  assert.notEqual(stored.token, session.token);
  assert.equal(stored.token.length, 64);
  assert.equal(getSessionUser(session.token)?.id, user.id);
  // The stored hash is not itself a credential.
  assert.equal(getSessionUser(stored.token), null);
  assert.equal(getSessionUser(session.token)?.id, user.id);
  deleteSession(session.token);
  assert.equal(getSessionUser(session.token), null);
});

test('a sign-in deletes expired sessions, and looking a session up writes nothing', () => {
  const user = createUserAndClaimItems({ googleId: 'sweep-google-id', email: 'sweep@example.com', displayName: null, photoUrl: null });
  const sessions = () => (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id) as { n: number }).n;
  const expired = createSession(user.id);
  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, user.id);
  assert.equal(getSessionUser(expired.token), null);
  assert.equal(sessions(), 1);

  const fresh = createSession(user.id);
  assert.equal(sessions(), 1);
  assert.equal(getSessionUser(fresh.token)?.id, user.id);
});

test('a session renews only to a later expiry and never once expired, and a renewal the database refuses changes nothing', () => {
  const user = createUserAndClaimItems({ googleId: 'renew-google-id', email: 'renew@example.com', displayName: null, photoUrl: null });
  const { token, expiresAt } = createSession(user.id);
  const session = getSession(token);
  assert.equal(session?.user.id, user.id);
  assert.equal(session?.expiresAt, expiresAt);
  assert.ok(session.createdAt <= Date.now() && session.createdAt < expiresAt);

  assert.equal(extendSession(token, expiresAt - 1), false);
  assert.equal(getSession(token)?.expiresAt, expiresAt);
  assert.equal(extendSession(token, expiresAt + 1_000), true);
  assert.equal(getSession(token)?.expiresAt, expiresAt + 1_000);

  // As when an importer holds the write lock past busy_timeout: the caller learns the session didn't move.
  db.exec(`CREATE TEMP TRIGGER refuse_renewal BEFORE UPDATE OF expires_at ON sessions
    BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);
  try {
    assert.equal(extendSession(token, expiresAt + 2_000), false);
  } finally {
    db.exec('DROP TRIGGER refuse_renewal');
  }
  assert.equal(getSession(token)?.expiresAt, expiresAt + 1_000);

  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, user.id);
  assert.equal(extendSession(token, Date.now() + 1_000_000), false);
  assert.equal(getSession(token), null);
});
