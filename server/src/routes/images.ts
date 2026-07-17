import { Hono } from 'hono';
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';

export const imageRoutes = new Hono();

const DEEPINFRA_FLUX_URL = 'https://api.deepinfra.com/v1/inference/black-forest-labs/FLUX-1-schnell';
const REPLICATE_FLUX_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';
const IMAGE_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    return await proxyFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getImageDimensions(aspectRatio: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '16:9': return { width: 1024, height: 576 };
    case '9:16': return { width: 576, height: 1024 };
    case '4:3': return { width: 896, height: 672 };
    case '3:4': return { width: 672, height: 896 };
    case '1:1':
    default: return { width: 768, height: 768 };
  }
}

// POST /api/generate-image
imageRoutes.post('/generate-image', async (c) => {
  const { prompt, aspectRatio = '1:1' } = await c.req.json().catch(() => ({}));
  if (typeof prompt !== 'string' || !prompt.trim()) return c.json({ error: 'Prompt is required' }, 400);
  if (prompt.length > 2000) return c.json({ error: 'Prompt is too long' }, 400);

  const styledPrompt = `(Icon style), minimal vector art, flat design, ${prompt}. solid background. No text.`;
  const dimensions = getImageDimensions(aspectRatio);

  // Try DeepInfra FLUX Schnell (primary)
  const deepinfraKey = env.DEEPINFRA_API_KEY;
  if (deepinfraKey) {
    try {
      console.log('Generating with DeepInfra FLUX Schnell...');
      const response = await fetchWithTimeout(DEEPINFRA_FLUX_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${deepinfraKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: styledPrompt,
          width: dimensions.width,
          height: dimensions.height,
          num_inference_steps: 4,
        }),
      });

      if (response.ok) {
        const data: any = await response.json();
        if (data.images && data.images.length > 0) {
          const base64Image = data.images[0];
          const imageData = base64Image.startsWith('data:')
            ? base64Image
            : `data:image/png;base64,${base64Image}`;
          return c.json({ imageData });
        }
      } else {
        const status = response.status;
        console.warn('DeepInfra FLUX failed:', status);
        if (status === 429 || status === 402) {
          // Fall through to Replicate
          console.warn('DeepInfra quota exceeded, trying Replicate...');
        }
      }
    } catch (err: any) {
      console.warn('DeepInfra FLUX error:', err.message);
    }
  }

  // Fallback to Replicate FLUX Schnell
  const replicateKey = env.REPLICATE_API_TOKEN;
  if (!replicateKey) {
    return c.json({ imageData: undefined, error: 'NO_API_KEY' });
  }

  try {
    console.log('Trying Replicate FLUX Schnell (fallback)...');
    const response = await fetchWithTimeout(REPLICATE_FLUX_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${replicateKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      body: JSON.stringify({
        input: {
          prompt: styledPrompt,
          aspect_ratio: aspectRatio,
          output_format: 'webp',
          output_quality: 50,
          num_outputs: 1,
        },
      }),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 429 || status === 402) {
        return c.json({ imageData: undefined, error: 'QUOTA_EXCEEDED' });
      }
      return c.json({ error: `Replicate API error: ${status}` }, 500);
    }

    const prediction: any = await response.json();

    if (prediction.status === 'succeeded' && prediction.output?.length > 0) {
      const imageUrl = prediction.output[0];
      const imageResponse = await fetchWithTimeout(imageUrl);
      if (!imageResponse.ok) throw new Error('Failed to fetch generated image');

      const declaredLength = Number(imageResponse.headers.get('content-length') || '0');
      if (declaredLength > MAX_IMAGE_BYTES) throw new Error('Generated image is too large');
      const arrayBuffer = await imageResponse.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) throw new Error('Generated image is too large');
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mimeType = (imageResponse.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!/^image\/(?:avif|gif|jpeg|png|webp)$/.test(mimeType)) {
        throw new Error('Generated response was not an image');
      }
      return c.json({ imageData: `data:${mimeType};base64,${base64}` });
    }

    if (prediction.status === 'failed') {
      return c.json({ error: prediction.error || 'Image generation failed' }, 500);
    }

    return c.json({ imageData: undefined });
  } catch (error: any) {
    const msg = error.message || '';
    if (msg.includes('429') || msg.includes('402') || msg.includes('quota') || msg.includes('billing')) {
      return c.json({ imageData: undefined, error: 'QUOTA_EXCEEDED' });
    }
    console.warn('Image generation failed:', msg);
    return c.json({ error: msg }, 500);
  }
});
