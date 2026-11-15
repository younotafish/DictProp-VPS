import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeImages } from '../../services/imageProcessing.ts';

// The optimizer draws on a canvas, which Node lacks: a stand-in canvas records the drawing calls and returns a
// chosen encoding, so the order of the calls and the choice of result can be checked.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function drawWith({ width, height, encoded }: { width: number; height: number; encoded: string }): string[] {
  const calls: string[] = [];
  const context = {
    set fillStyle(value: string) { calls.push(`fillStyle ${value}`); },
    fillRect: (...args: number[]) => calls.push(`fillRect ${args.join(',')}`),
    drawImage: (_bitmap: unknown, ...args: number[]) => calls.push(`drawImage ${args.join(',')}`),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: (_type: string, options: unknown) => {
      calls.push(`getContext ${JSON.stringify(options)}`);
      return context;
    },
    toDataURL: (type: string) => (type === 'image/webp' ? encoded : 'data:image/jpeg;base64,unused'),
  };
  Object.assign(globalThis, {
    createImageBitmap: async () => ({ width, height, close: () => calls.push('close') }),
    document: { createElement: () => canvas },
  });
  return calls;
}

test.after(() => {
  const globals = globalThis as Record<string, unknown>;
  delete globals.createImageBitmap;
  delete globals.document;
});

test('a picture is flattened onto white before it is drawn, so transparent areas are not black', async () => {
  const calls = drawWith({ width: 1600, height: 1200, encoded: 'data:image/webp;base64,UklGRg==' });
  const [optimized] = await optimizeImages([{ id: 'sticker', base64: PNG }]);
  assert.deepEqual(optimized, { id: 'sticker', base64: 'data:image/webp;base64,UklGRg==' });
  assert.deepEqual(calls, [
    'getContext {"alpha":false}',
    'fillStyle #fff',
    'fillRect 0,0,1280,960',
    'drawImage 0,0,1280,960',
    'close',
  ]);
});

test('a picture that needed no resizing stays as it came unless re-encoding shrinks it', async () => {
  drawWith({ width: 10, height: 10, encoded: `data:image/webp;base64,${'A'.repeat(PNG.length)}` });
  assert.deepEqual(await optimizeImages([{ id: 'small', base64: PNG }]), [{ id: 'small', base64: PNG }]);
});
