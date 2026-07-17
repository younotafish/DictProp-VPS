import { Hono } from 'hono';
import { getAllItems, upsertItemImageBinary } from '../db.js';
import { createImageBackfillManager } from '../image-backfill.js';
import { generateImageQueued, ImageGenerationError, type ImageAspectRatio } from '../image-generation.js';
import type { AuthVariables } from '../middleware/auth.js';

export const imageRoutes = new Hono<{ Variables: AuthVariables }>();

const imageBackfill = createImageBackfillManager({
  loadItems: userId => getAllItems(true, userId),
  generateImage: generateImageQueued,
  saveImage: (userId, imageId, image) => upsertItemImageBinary(imageId, image.data, image.mimeType, userId),
});

imageRoutes.post('/generate-image', async (c) => {
  const { prompt, aspectRatio = '1:1' } = await c.req.json().catch(() => ({}));
  if (typeof prompt !== 'string' || !prompt.trim()) return c.json({ error: 'Prompt is required' }, 400);
  if (prompt.length > 2000) return c.json({ error: 'Prompt is too long' }, 400);
  if (!['1:1', '16:9', '9:16', '4:3', '3:4'].includes(aspectRatio)) {
    return c.json({ error: 'Unsupported aspect ratio' }, 400);
  }

  try {
    let image: Awaited<ReturnType<typeof generateImageQueued>>;
    try {
      image = await generateImageQueued(prompt.trim(), aspectRatio as ImageAspectRatio);
    } catch (error) {
      if (!(error instanceof ImageGenerationError) || !error.retryable) throw error;
      await new Promise(resolve => setTimeout(resolve, 750));
      image = await generateImageQueued(prompt.trim(), aspectRatio as ImageAspectRatio);
    }
    return new Response(image.data, {
      headers: { 'Content-Type': image.mimeType, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof ImageGenerationError &&
        (error.code === 'NO_API_KEY' || error.code === 'QUOTA_EXCEEDED')) {
      return c.json({ imageData: undefined, error: error.code });
    }
    console.warn('Image generation failed:', error instanceof Error ? error.message : error);
    return c.json({ error: 'Image generation failed' }, 502);
  }
});

imageRoutes.post('/image-backfill', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Invalid image backfill request' }, 400);
  }
  const project = body?.project;
  const itemIds = body?.itemIds;
  if (project !== undefined && (typeof project !== 'string' || project.length === 0 || project.length > 200)) {
    return c.json({ error: 'Invalid project' }, 400);
  }
  if (itemIds !== undefined && (!Array.isArray(itemIds) || itemIds.length > 5_000 ||
      itemIds.some((id: unknown) => typeof id !== 'string' || id.length === 0 || id.length > 200))) {
    return c.json({ error: 'Invalid item ids' }, 400);
  }

  const status = imageBackfill.start(c.get('user').id, {
    ...(project !== undefined ? { project } : {}),
    ...(itemIds !== undefined ? { itemIds: Array.from(new Set(itemIds as string[])) } : {}),
  });
  return c.json(status, status.running ? 202 : 200);
});

imageRoutes.get('/image-backfill', (c) => c.json(imageBackfill.getStatus(c.get('user').id)));

imageRoutes.delete('/image-backfill', (c) => c.json(imageBackfill.cancel(c.get('user').id)));
