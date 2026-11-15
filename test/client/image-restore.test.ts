import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreImagesToServer, type ImageRestoreJob, type ImageRestoreProgress } from '../../services/imageRestore.ts';

function job(options: { server: string[]; stored: string[]; live: string[]; unreadable?: string[]; failingUpload?: string }) {
  const reports: ImageRestoreProgress[] = [];
  const uploads: string[][] = [];
  const steps: string[] = [];
  const config: ImageRestoreJob = {
    serverImageIds: async () => { steps.push('server list'); return new Set(options.server); },
    storedImageIds: async () => { steps.push('device list'); return new Set(options.stored); },
    liveImageIds: () => { steps.push('live ids'); return new Set(options.live); },
    loadImages: async ids => new Map(ids.filter(id => !options.unreadable?.includes(id)).map(id => [id, `data:${id}`])),
    upload: async images => {
      const ids = Object.keys(images);
      if (options.failingUpload && ids.includes(options.failingUpload)) throw new Error('upload failed');
      uploads.push(ids);
    },
    report: progress => { reports.push(progress); },
  };
  return { config, reports, uploads, steps };
}

test('only images stored here, missing on the server and shown by a current card are uploaded', async () => {
  const run = job({ server: ['on-server'], stored: ['on-server', 'missing', 'deleted-card'], live: ['on-server', 'missing'] });
  const final = await restoreImagesToServer(run.config);
  assert.deepEqual(run.uploads, [['missing']]);
  assert.deepEqual(final, { phase: 'done', done: 1, total: 1, failed: 0 });
  assert.deepEqual(run.reports.map(progress => progress.phase), ['checking', 'uploading', 'uploading']);
  assert.deepEqual(run.steps.slice(-1), ['live ids'], 'the live cards are read once both lists are in');
});

test('with nothing to restore it ends at once, saying so', async () => {
  const run = job({ server: ['a'], stored: ['a'], live: ['a'] });
  assert.deepEqual(await restoreImagesToServer(run.config), { phase: 'done', done: 0, total: 0, failed: 0 });
  assert.deepEqual(run.uploads, []);
});

test('images go up eight at a time; unreadable ones and a failed batch count as failed', async () => {
  const ids = Array.from({ length: 19 }, (_, index) => `image-${index}`);
  const run = job({ server: [], stored: ids, live: ids, unreadable: ['image-3'], failingUpload: 'image-9' });
  const final = await restoreImagesToServer(run.config);
  assert.deepEqual(run.uploads.map(batch => batch.length), [7, 3], 'the second batch of eight failed; the third holds three');
  assert.deepEqual(final, { phase: 'done', done: 19, total: 19, failed: 1 + 8 });
});

test('a list that cannot be fetched fails the restore', async () => {
  const run = job({ server: [], stored: [], live: [] });
  await assert.rejects(restoreImagesToServer({ ...run.config, serverImageIds: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepEqual(run.reports.map(progress => progress.phase), ['checking']);
});
