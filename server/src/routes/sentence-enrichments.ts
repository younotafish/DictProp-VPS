import { Hono } from 'hono';
import { getSentenceEnrichmentForText, getSentenceEnrichmentImage } from '../db.js';
import type { AppEnv } from '../middleware/auth.js';
import { readJsonObject } from '../middleware/json-body.js';
import { imageResponse } from './item-images.js';

export const sentenceEnrichmentRoutes = new Hono<AppEnv>();

// Prepared example metadata is global source material. Looking it up must not create a user item:
// expanding an example is a read-only action, while bookmarking remains an explicit save.
sentenceEnrichmentRoutes.post('/sentence-enrichments/lookup', async (c) => {
  const body = await readJsonObject(c);
  const text = body?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) {
    return c.json({ error: 'Expected a non-empty sentence' }, 400);
  }
  const enrichment = getSentenceEnrichmentForText(text);
  if (!enrichment) return c.json({ found: false });
  return c.json({
    found: true,
    analysis: enrichment.analysis,
    analysisGeneratedAt: enrichment.generatedAt,
    ...(enrichment.imageContentHash && enrichment.imageMimeType
      ? { imageUrl: `/api/sentence-enrichments/${enrichment.lookupHash}/image` }
      : {}),
  });
});

// A newer wave can replace a sentence's image at the same URL, so it revalidates by content hash as item images do.
sentenceEnrichmentRoutes.get('/sentence-enrichments/:lookupHash/image', (c) => {
  const image = getSentenceEnrichmentImage(c.req.param('lookupHash'));
  if (!image) return c.json({ error: 'Not found' }, 404);
  return imageResponse(c, image);
});
