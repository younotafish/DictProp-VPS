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
] as const;

// This is the one new/new sentence pair. Its first id is the copy carried through the
// independent corpus audit, so keep that identity even when both rows have identical content/SRS.
const PREFERRED_SURVIVOR_IDS = new Set(['338d98fd-7222-4b07-b58d-321557216552']);

const items = getAllItems(true, owner.id) as any[];
const byId = new Map(items.map(item => [item.data.id, item]));
const imageIds = new Set((db.prepare('SELECT id FROM item_images WHERE user_id = ?').all(owner.id) as Array<{ id: string }>).map(row => row.id));
const normalize = (value: unknown) => String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
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

function assertSameIdentity(group: any[]): void {
  const first = group[0];
  if (group.some(item => item.type !== first.type)) throw new Error('Duplicate repair group changed item type');
  if (first.type === 'vocab') {
    const key = `${normalize(first.data.word)}\u0000${normalize(first.data.sense)}`;
    if (group.some(item => `${normalize(item.data.word)}\u0000${normalize(item.data.sense)}` !== key)) {
      throw new Error(`Vocab duplicate group changed identity: ${group.map(item => item.data.id).join(',')}`);
    }
    return;
  }
  const key = [normalize(first.data.text), normalize(first.data.sourceWord), normalize(first.data.sourceSense)].join('\u0000');
  if (group.some(item => [normalize(item.data.text), normalize(item.data.sourceWord), normalize(item.data.sourceSense)].join('\u0000') !== key)) {
    throw new Error(`Sentence duplicate group changed identity: ${group.map(item => item.data.id).join(',')}`);
  }
}

const duplicatePlans = DUPLICATE_GROUPS.flatMap(ids => {
  const live = ids.map(id => byId.get(id)).filter(item => item && !item.isDeleted);
  if (live.length < 2) return [];
  assertSameIdentity(live);
  const content = [...live].sort((left, right) =>
    Number(PREFERRED_SURVIVOR_IDS.has(right.data.id)) - Number(PREFERRED_SURVIVOR_IDS.has(left.data.id)) ||
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
    const merged = {
      ...survivor,
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
  duplicateGroups: duplicatePlans.map(plan => ({
    survivorId: plan.survivor.data.id,
    learningSourceId: plan.learning.data.id,
    loserIds: plan.losers.map((item: any) => item.data.id),
  })),
  invalidSrsCount: invalidSrsItems.filter(item => !consolidatedIds.has(item.data.id)).length,
  invalidSrsIds: invalidSrsItems.filter(item => !consolidatedIds.has(item.data.id)).map(item => item.data.id),
  staleImageReferenceCount: staleImageIds.length,
  staleImageReferenceIds: staleImageIds.slice(0, 100),
})}\n`);
