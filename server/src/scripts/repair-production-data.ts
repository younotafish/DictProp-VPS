import { db, getAllItems, listAllUsers, softDeleteItem, upsertItem } from '../db.js';
import { env } from '../env.js';
import { isOwnerUser } from '../owner-access.js';

const apply = process.argv.includes('--apply');
const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

// These groups come from the production audit and were manually verified against the encrypted export.
// Keeping the explicit identities makes this repair surgical: later cards with similar labels are never
// consolidated merely because a heuristic happens to consider them alike.
const DUPLICATE_GROUPS = [
  ['fd61783a-1b03-41ee-b35d-e2b1646fe707', 'ddc49d46-3feb-4188-95c4-4fdb3c096270'],
  ['4c0c2e4f-eb13-4107-b936-bd374b19e153', 'cf963c1e-ba0f-4b5a-a34a-a84e03b4227f'],
  ['d88811ee-7967-417c-a263-fdffb7a45397', '3fa263b1-c43c-4e63-b842-8354ffec0c5b'],
  ['c9256935-cfb3-448b-84d8-7365577e8932', '758551ce-8c57-4dc5-8c86-13cad39bd721'],
  ['1cc6919f-284c-4214-b959-14a5ac41be6e', '571743c3-f2f7-4863-95bb-28e11083875e'],
  ['b9319948-6f97-44a0-b953-59aec9bcb6a7', 'd6bb74d3-7ce9-417a-adf5-19edeac573f2'],
  ['a199e64f-7527-4b5c-a4c3-1640e6a3aba9', 'd5b3101a-08d3-4202-8842-553f30a54b47'],
  ['43163e94-5a1e-4929-9076-25bff9a65768', '07de4a23-8f9f-4bcc-b78f-522b3606b8bb'],
  ['9f3a3199-6158-433f-bb6b-9b494bc7fa91', '9ec6d5f6-a839-4ad7-a35b-621d9b122536'],
  ['ffbc6c78-ed54-4df6-b34d-7235f20ba7d1', 'fe3ba1b4-1813-491c-b8f5-c1daa53db1a5'],
  ['dc1c8ec1-a0a8-4fbc-b7bc-33ccd5327764', '8983bda2-b027-4e5d-b1c1-847c425a8d15'],
  ['22ad4621-6c1b-4283-9ac5-73dced309ac3', '856120f2-fcee-4e1a-a389-180f8d118e6e'],
  ['b657e441-b221-43bc-80bd-8d4b1426872c', '4cbe660c-c32a-4463-be36-2ae32239c39a'],
  ['609215d8-3ac2-4aa1-a9b8-ba8a3d0274bd', '4e7b2421-978b-42ab-b6e2-f2a273c6362b'],
  ['c35f7ffa-8a22-4035-b9f9-3c8cb2f60eb5', '9aa191a4-257c-4a00-9c6f-6b875a1001b7'],
  ['6cf489c6-6225-453e-b002-2f604cf062ab', '020ab803-6f8a-42d8-b40e-47c3589eb3c8'],
  ['32c632bc-7b5d-4982-80db-8d43e9690b5f', '1caa1148-2a61-4b7a-bb45-1a0a02fed6a2'],
  ['52fa4051-c790-426e-a187-fa5306d25a07', 'feefbb8e-6a08-449d-861f-c555f597417f'],
  ['e6cbe241-59e1-4724-8e29-25ffd6e2a76e', '730d6935-f7e8-4309-a53c-b1af57bdebf0'],
  ['d6b2a3f8-6595-48f0-84c1-fb8ec75854d7', 'f7090e69-2105-4fed-86ca-7af9b8a289d7'],
  ['342bc661-9c3e-4cff-83ef-4b71d01164c2', '8e45d70f-04c7-49bb-9e0c-2aef3ae2c411'],
  ['24ee4496-9c5d-4c47-94e0-600427f7164f', 'ad005e87-3012-48db-a61d-6cc38c113321'],
  ['5d9b0f5d-cc18-4ae1-87ef-f12c2bb5a85c', '62500b17-12ef-4179-aa2f-fa666fe204d9'],
  ['bff0455d-d061-4767-9b69-fddd76104a0b', 'b6721238-1995-4208-8e52-8c92dae417f9'],
  ['338d98fd-7222-4b07-b58d-321557216552', '331ea78a-4472-4c05-9d7d-3f5ef74b2ff9'],
  ['f8e38ce0-9289-411b-b9c4-155bfd85e7a3', 'c27cfc10-5fc0-41f0-b666-c990e8cc59ef'],
] as const;

// These pairs used superficially different legacy labels, so the exact-string audit could not
// consolidate them. GPT-5.6 independently reviewed both definitions and every example in each
// pair and classified all of them as the same lemma and exact meaning. The first id in each pair
// is the adjudicated survivor; examples and learning history are still merged below.
const SEMANTIC_DUPLICATE_GROUPS = [
  ['6e7c13ab-f74f-49c5-90ac-bf28ec220c0b', '5b30ebf0-ebc8-4b9e-b039-480fbf97428a'],
  ['62f55785-4c98-4246-87a6-4dcd734033fb', '7eefb850-1d00-442f-86eb-8781c71e7695'],
  ['9d8877f8-ca7a-48e2-9fe2-f28489c85bb2', '223e680b-b30c-45c7-bb2d-2eb0b3f9456c'],
  ['1ff7b78f-ed81-413d-9e9a-0cfeca6f374f', '65bb7777-afe7-442c-b702-985df912f029'],
  ['3dff0387-862e-4bbe-8304-f5d8f348e5d8', '189a23a2-e035-408b-aabe-4b6f2d2612dd'],
  ['54860d97-3eff-4223-bc47-c7c504b66be1', '710cf119-6d09-4af9-b925-84b62966518a'],
  ['182135dd-e456-4459-8876-4b03160006a4', 'b3327659-21c1-4cef-a4f5-3f2f8c18bf6f'],
  ['148d5104-efb3-4353-9d59-3e830e188f39', '352e2be8-149e-421e-9395-95c79b1e5469'],
  ['12901cd7-8218-4c8b-acaf-a05ad493efbe', '7da770b1-0097-4600-bf78-2c3d2dbe52cb'],
  ['0deda947-f9a6-4ba8-9316-248687acf278', 'fe436250-3dee-4319-a6a8-e362110b3aa3'],
  ['c1a93ed2-4131-4c93-9d1c-2483c27b9ce1', 'be0c9f22-cb64-4b22-aaf2-8d1791353921'],
  ['930fdd75-46e7-4584-9f3c-59f4502a97aa', 'dc885f58-8179-4f3d-8d3c-1c4c65627815'],
  ['65b9381d-204f-414f-b7cc-1d79161fe90c', 'af973afe-e379-43a3-b91a-55056de36f73'],
  ['0f091d0b-d2fb-46ee-931a-e9065cc1ee8b', '61511471-7d10-4539-8e09-34400b1e0fbf'],
  ['e47caaaa-9945-4fcc-ae6b-0209f73efd98', '89742cd3-11b5-4375-9585-6fa70458c0bb'],
  ['b2bd93fc-1388-4025-8b92-5c408b346fd2', '8b9c0132-2c61-469b-b0fb-f490a87695a4'],
  ['ec3e87ea-d383-4590-8801-672c50fce93d', '0eef9ba1-9c20-43e0-8d6e-00cf47a55c96'],
  ['f7d7b498-7353-4ad5-9165-29262447423f', '060c2661-2c07-403a-9d21-c28d549dbca4'],
  ['0ce6446d-d438-48f2-b4ab-df8d01df9511', '49b2c515-1cf6-4f81-b09d-a19acbaeb885'],
  ['8874b2c6-2bbd-4a1c-99f8-c2e983c2c839', '524bc83a-63ff-4305-b51d-3b90e97a03c0'],
  ['d47f3576-8340-49a7-80d7-b4f67329ef62', 'ee189dd2-2913-4987-bc54-eb0a2e02c216'],
  ['0fca1f40-75c6-4c19-a3b4-04359eb258a8', '7ce8746c-8e82-4766-bc61-944f65481a34'],
  ['7d480237-65f1-4390-a31b-2d22fbb9f5d3', 'f7d7b498-7353-4ad5-9165-29262447423f'],
] as const;

// Keep the independently selected identity for this one new/new sentence pair even when another
// row happens to contain more legacy text. Semantic groups use their first id directly below.
const PREFERRED_SURVIVOR_IDS = new Set([
  '338d98fd-7222-4b07-b58d-321557216552',
  'f8e38ce0-9289-411b-b9c4-155bfd85e7a3',
]);

const items = getAllItems(true, owner.id) as any[];
const byId = new Map(items.map(item => [item.data.id, item]));
const imageIds = new Set((db.prepare('SELECT id FROM item_images WHERE user_id = ?').all(owner.id) as Array<{ id: string }>).map(row => row.id));
const normalize = (value: unknown) => String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
const normalizeSentence = (value: unknown) => normalize(String(value || '')
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^\[\]]+)\]\]/g, '$1'));
const finite = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

function contentScore(item: any): number {
  const data = item.data || {};
  let score = data.usageAudit ? 1_000 : 0;
  if (data.analysis) score += 2_000;
  if (imageIds.has(data.id)) score += 500;
  for (const field of ['sense', 'chinese', 'ipa', 'definition', 'history', 'register', 'mnemonic', 'imagePrompt']) {
    if (typeof data[field] === 'string' && data[field].trim()) score += Math.min(100, data[field].length);
  }
  for (const field of ['examples', 'synonyms', 'antonyms', 'confusables', 'forms', 'wordFamily']) {
    if (Array.isArray(data[field])) score += data[field].length * 10;
  }
  return score;
}

function learningScore(item: any): [number, number, number] {
  return [
    finite(item.srs?.lastReviewDate),
    finite(item.srs?.totalReviews),
    finite(item.srs?.stability),
  ];
}

function compareTuple(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function assertSameIdentity(group: any[], allowSenseMismatch: boolean): void {
  const first = group[0];
  if (group.some(item => item.type !== first.type)) throw new Error('Duplicate repair group changed item type');
  if (first.type === 'vocab') {
    const key = allowSenseMismatch
      ? normalize(first.data.word)
      : `${normalize(first.data.word)}\u0000${normalize(first.data.sense)}`;
    const identityOf = (item: any) => allowSenseMismatch
      ? normalize(item.data.word)
      : `${normalize(item.data.word)}\u0000${normalize(item.data.sense)}`;
    if (group.some(item => identityOf(item) !== key)) {
      throw new Error(`Vocab duplicate group changed identity: ${group.map(item => item.data.id).join(',')}`);
    }
    return;
  }
  const key = [normalizeSentence(first.data.text), normalize(first.data.sourceWord), normalize(first.data.sourceSense)].join('\u0000');
  if (group.some(item => [normalizeSentence(item.data.text), normalize(item.data.sourceWord), normalize(item.data.sourceSense)].join('\u0000') !== key)) {
    throw new Error(`Sentence duplicate group changed identity: ${group.map(item => item.data.id).join(',')}`);
  }
}

const duplicateGroups = [
  ...DUPLICATE_GROUPS.map(ids => ({
    ids,
    semantic: false,
    preferredSurvivorId: ids.find(id => PREFERRED_SURVIVOR_IDS.has(id)),
  })),
  ...SEMANTIC_DUPLICATE_GROUPS.map(ids => ({
    ids,
    semantic: true,
    preferredSurvivorId: ids[0],
  })),
];
const duplicatePlans = duplicateGroups.flatMap(({ ids, semantic, preferredSurvivorId }) => {
  const live = ids.map(id => byId.get(id)).filter(item => item && !item.isDeleted);
  if (live.length < 2) return [];
  assertSameIdentity(live, semantic);
  const content = [...live].sort((left, right) =>
    Number(right.data.id === preferredSurvivorId) - Number(left.data.id === preferredSurvivorId) ||
    contentScore(right) - contentScore(left) ||
    compareTuple(learningScore(right), learningScore(left)) ||
    finite(left.savedAt) - finite(right.savedAt) ||
    String(left.data.id).localeCompare(String(right.data.id)),
  )[0];
  const learning = [...live].sort((left, right) =>
    compareTuple(learningScore(right), learningScore(left)) ||
    String(left.data.id).localeCompare(String(right.data.id)),
  )[0];
  return [{
    survivor: content,
    learning,
    losers: live.filter(item => item.data.id !== content.data.id),
    semantic,
  }];
});

const loserIds = new Set(duplicatePlans.flatMap(plan => plan.losers.map((item: any) => item.data.id)));
const consolidatedIds = new Set([
  ...loserIds,
  ...duplicatePlans.map(plan => plan.survivor.data.id),
]);
const invalidSrsItems = items.filter(item =>
  !item.srs || item.srs.id !== item.data.id || item.srs.type !== item.type ||
  ['nextReview', 'interval', 'memoryStrength', 'lastReviewDate', 'totalReviews', 'correctStreak', 'stability']
    .some(field => finite(item.srs?.[field], -1) < 0),
);

const futureLiveImageIds = new Set<string>();
for (const item of items) {
  if (item.isDeleted || loserIds.has(item.data.id)) continue;
  if (typeof item.data?.id === 'string') futureLiveImageIds.add(item.data.id);
  if (Array.isArray(item.data?.vocabs)) {
    for (const vocab of item.data.vocabs) if (typeof vocab?.id === 'string') futureLiveImageIds.add(vocab.id);
  }
}
const staleImageIds = [...imageIds].filter(id => !futureLiveImageIds.has(id));

function normalizedSrs(item: any, source = item.srs || {}): any {
  return {
    ...source,
    id: item.data.id,
    type: item.type,
    nextReview: finite(source.nextReview),
    interval: finite(source.interval),
    memoryStrength: finite(source.memoryStrength),
    lastReviewDate: finite(source.lastReviewDate),
    totalReviews: finite(source.totalReviews),
    correctStreak: finite(source.correctStreak),
    stability: finite(source.stability),
  };
}

function mergedExamplesFor(plan: (typeof duplicatePlans)[number]): string[] {
  const examples: string[] = [];
  const seen = new Set<string>();
  for (const item of [plan.survivor, ...plan.losers]) {
    for (const example of Array.isArray(item.data?.examples) ? item.data.examples : []) {
      if (typeof example !== 'string' || !example.trim()) continue;
      const key = normalize(example);
      if (seen.has(key)) continue;
      seen.add(key);
      examples.push(example);
    }
  }
  return examples;
}

const sentenceRelinksBySurvivor = new Map<string, any[]>();
for (const plan of duplicatePlans) {
  if (!plan.semantic || plan.survivor.type !== 'vocab') continue;
  const loserKeys = new Set(plan.losers.map((loser: any) =>
    `${normalize(loser.data.word)}\u0000${normalize(loser.data.sense)}`));
  const survivorKey = `${normalize(plan.survivor.data.word)}\u0000${normalize(plan.survivor.data.sense)}`;
  loserKeys.delete(survivorKey);
  const linked = items.filter(item => item.type === 'sentence' && !item.isDeleted && loserKeys.has(
    `${normalize(item.data.sourceWord)}\u0000${normalize(item.data.sourceSense)}`));
  sentenceRelinksBySurvivor.set(plan.survivor.data.id, linked);
}

const transferImage = db.prepare(`
  INSERT INTO item_images (id, user_id, data, updated_at, mime_type, content_hash)
  SELECT ?, user_id, data, ?, mime_type, content_hash FROM item_images
  WHERE id = ? AND user_id = ?
  ON CONFLICT(id) DO NOTHING
`);
const deleteImage = db.prepare('DELETE FROM item_images WHERE id = ? AND user_id = ?');

const applyRepair = db.transaction(() => {
  const now = Date.now();
  for (const plan of duplicatePlans) {
    const survivor = plan.survivor;
    const mergedData = survivor.type === 'vocab'
      ? { ...survivor.data, examples: mergedExamplesFor(plan) }
      : survivor.data;
    const merged = {
      ...survivor,
      data: mergedData,
      srs: normalizedSrs(survivor, plan.learning.srs),
      savedAt: Math.min(...[survivor, ...plan.losers].map(item => finite(item.savedAt, now))),
      updatedAt: Math.max(now, finite(survivor.updatedAt) + 1),
    };
    const imageDonor = [survivor, ...plan.losers].find(item => imageIds.has(item.data.id));
    if (!imageIds.has(survivor.data.id) && imageDonor) {
      transferImage.run(survivor.data.id, now, imageDonor.data.id, owner.id);
    }
    const result = upsertItem(merged, owner.id);
    if (result.conflicted) throw new Error(`Duplicate survivor changed during repair: ${survivor.data.id}`);
    for (const sentence of sentenceRelinksBySurvivor.get(survivor.data.id) || []) {
      const sentenceResult = upsertItem({
        ...sentence,
        data: {
          ...sentence.data,
          sourceWord: survivor.data.word,
          sourceSense: survivor.data.sense,
        },
        srs: normalizedSrs(sentence),
        updatedAt: Math.max(now, finite(sentence.updatedAt) + 1),
      }, owner.id);
      if (sentenceResult.conflicted) {
        throw new Error(`Linked sentence changed during duplicate repair: ${sentence.data.id}`);
      }
    }
    for (const loser of plan.losers) softDeleteItem(loser.data.id, owner.id);
  }

  for (const item of invalidSrsItems) {
    // Duplicate consolidation above normalizes the survivor and deletes every loser.
    if (consolidatedIds.has(item.data.id)) continue;
    const result = upsertItem({
      ...item,
      srs: normalizedSrs(item),
      updatedAt: Math.max(now, finite(item.updatedAt) + 1),
    }, owner.id);
    if (result.conflicted) throw new Error(`SRS item changed during repair: ${item.data.id}`);
  }

  for (const id of staleImageIds) deleteImage.run(id, owner.id);
  db.prepare(`DELETE FROM image_blobs WHERE NOT EXISTS (
    SELECT 1 FROM item_images WHERE item_images.content_hash = image_blobs.content_hash
  )`).run();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('UPDATE items SET project = NULL WHERE project IS NOT NULL').run();
  db.prepare('DELETE FROM projects').run();
});

if (apply) applyRepair();

process.stdout.write(`${JSON.stringify({
  mode: apply ? 'applied' : 'dry-run',
  duplicateGroupCount: duplicatePlans.length,
  duplicateLoserCount: loserIds.size,
  semanticDuplicateGroupCount: duplicatePlans.filter(plan => plan.semantic).length,
  relinkedSentenceCount: [...sentenceRelinksBySurvivor.values()].reduce((sum, linked) => sum + linked.length, 0),
  duplicateGroups: duplicatePlans.map(plan => ({
    survivorId: plan.survivor.data.id,
    learningSourceId: plan.learning.data.id,
    loserIds: plan.losers.map((item: any) => item.data.id),
    semantic: plan.semantic,
  })),
  invalidSrsCount: invalidSrsItems.filter(item => !consolidatedIds.has(item.data.id)).length,
  invalidSrsIds: invalidSrsItems.filter(item => !consolidatedIds.has(item.data.id)).map(item => item.data.id),
  staleImageReferenceCount: staleImageIds.length,
  staleImageReferenceIds: staleImageIds.slice(0, 100),
})}\n`);
