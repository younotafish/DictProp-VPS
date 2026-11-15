import assert from 'node:assert/strict';
import test from 'node:test';
import { addPendingImageUploads, readPendingImageUploads, removePendingImageUploads } from '../../services/imageUploadQueue.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

test('failed uploads are listed per account, each once, newest last, at most two hundred', () => {
  const storage = new MemoryStorage();
  addPendingImageUploads('user', ['a', 'b'], storage);
  addPendingImageUploads('user', ['a', 'c'], storage);
  assert.deepEqual(readPendingImageUploads('user', storage), ['b', 'a', 'c'], 'listed again moves to the end');
  assert.deepEqual(readPendingImageUploads('someone else', storage), []);

  addPendingImageUploads('user', Array.from({ length: 250 }, (_, index) => `id-${index}`), storage);
  const listed = readPendingImageUploads('user', storage);
  assert.equal(listed.length, 200);
  assert.equal(listed[0], 'id-50', 'the oldest drop off first');
});

test('uploaded or vanished pictures come off the list, and an empty list leaves no key', () => {
  const storage = new MemoryStorage();
  addPendingImageUploads('user', ['a', 'b'], storage);
  removePendingImageUploads('user', ['a', 'unlisted'], storage);
  assert.deepEqual(readPendingImageUploads('user', storage), ['b']);
  removePendingImageUploads('user', ['b'], storage);
  assert.equal(storage.getItem('image_uploads_pending_user'), null);
});

test('a damaged or unwritable list reads as empty and never throws', () => {
  const storage = new MemoryStorage();
  storage.setItem('image_uploads_pending_user', '{not json');
  assert.deepEqual(readPendingImageUploads('user', storage), []);
  storage.setItem('image_uploads_pending_user', JSON.stringify(['a', 7, null, 'b']));
  assert.deepEqual(readPendingImageUploads('user', storage), ['a', 'b']);

  const full = new MemoryStorage();
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  addPendingImageUploads('user', ['a'], full);
  assert.deepEqual(readPendingImageUploads('user', full), []);
  addPendingImageUploads('', ['a'], storage);
  addPendingImageUploads('user', ['a'], null);
});
