import { env } from './env.js';
import { detectImageMimeType, type SupportedImageMime } from './image-format.js';
import { proxyFetch } from './proxy-fetch.js';

const DEEPINFRA_FLUX_URL = 'https://api.deepinfra.com/v1/inference/black-forest-labs/FLUX-1-schnell';
const REPLICATE_FLUX_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';
const IMAGE_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
export type ImageGenerationErrorCode = 'NO_API_KEY' | 'QUOTA_EXCEEDED' | 'UPSTREAM_ERROR';

export interface GeneratedImage {
  data: Buffer;
  mimeType: SupportedImageMime;
}

export class ImageGenerationError extends Error {
  constructor(
    readonly code: ImageGenerationErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    return await proxyFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getImageDimensions(aspectRatio: ImageAspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case '16:9': return { width: 1024, height: 576 };
    case '9:16': return { width: 576, height: 1024 };
    case '4:3': return { width: 896, height: 672 };
    case '3:4': return { width: 672, height: 896 };
    default: return { width: 768, height: 768 };
  }
}

function decodeGeneratedImage(value: unknown): GeneratedImage {
  if (typeof value !== 'string') {
    throw new ImageGenerationError('UPSTREAM_ERROR', 'Generated response did not contain image data', true);
  }
  const encoded = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const data = Buffer.from(encoded, 'base64');
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
    throw new ImageGenerationError('UPSTREAM_ERROR', 'Generated image has an invalid size', true);
  }
  const mimeType = detectImageMimeType(data);
  if (!mimeType) {
    throw new ImageGenerationError('UPSTREAM_ERROR', 'Generated response was not a supported image', true);
  }
  return { data, mimeType };
}

export async function generateImage(prompt: string, aspectRatio: ImageAspectRatio): Promise<GeneratedImage> {
  const styledPrompt = `(Icon style), minimal vector art, flat design, ${prompt}. solid background. No text.`;
  const dimensions = getImageDimensions(aspectRatio);
  let deepInfraFailure: ImageGenerationError | null = null;

  if (env.DEEPINFRA_API_KEY) {
    try {
      const response = await fetchWithTimeout(DEEPINFRA_FLUX_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.DEEPINFRA_API_KEY}`,
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
        const payload: any = await response.json();
        if (Array.isArray(payload.images) && payload.images.length > 0) {
          return decodeGeneratedImage(payload.images[0]);
        }
        deepInfraFailure = new ImageGenerationError('UPSTREAM_ERROR', 'DeepInfra returned no image', true);
      } else if (response.status === 429 || response.status === 402) {
        await response.text().catch(() => '');
        deepInfraFailure = new ImageGenerationError('QUOTA_EXCEEDED', 'DeepInfra image quota is unavailable', false);
      } else {
        await response.text().catch(() => '');
        deepInfraFailure = new ImageGenerationError('UPSTREAM_ERROR', `DeepInfra image request failed (${response.status})`, true);
      }
    } catch (error) {
      deepInfraFailure = error instanceof ImageGenerationError
        ? error
        : new ImageGenerationError('UPSTREAM_ERROR', error instanceof Error ? error.message : 'DeepInfra image request failed', true);
    }
  }

  if (!env.REPLICATE_API_TOKEN) {
    if (deepInfraFailure) throw deepInfraFailure;
    throw new ImageGenerationError('NO_API_KEY', 'No image generation provider is configured', false);
  }

  try {
    const response = await fetchWithTimeout(REPLICATE_FLUX_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        Prefer: 'wait',
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
    if (response.status === 429 || response.status === 402) {
      await response.text().catch(() => '');
      throw new ImageGenerationError('QUOTA_EXCEEDED', 'Image generation quota is unavailable', false);
    }
    if (!response.ok) {
      await response.text().catch(() => '');
      throw new ImageGenerationError('UPSTREAM_ERROR', `Replicate image request failed (${response.status})`, true);
    }

    const prediction: any = await response.json();
    if (prediction.status === 'failed') {
      throw new ImageGenerationError('UPSTREAM_ERROR', String(prediction.error || 'Replicate image generation failed'), true);
    }
    if (prediction.status !== 'succeeded' || !Array.isArray(prediction.output) || !prediction.output[0]) {
      throw new ImageGenerationError('UPSTREAM_ERROR', 'Replicate did not finish the image request', true);
    }

    const imageResponse = await fetchWithTimeout(String(prediction.output[0]));
    if (!imageResponse.ok) {
      throw new ImageGenerationError('UPSTREAM_ERROR', `Generated image download failed (${imageResponse.status})`, true);
    }
    const declaredLength = Number(imageResponse.headers.get('content-length') || '0');
    if (declaredLength > MAX_IMAGE_BYTES) {
      await imageResponse.body?.cancel();
      throw new ImageGenerationError('UPSTREAM_ERROR', 'Generated image is too large', false);
    }
    const data = Buffer.from(await imageResponse.arrayBuffer());
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
      throw new ImageGenerationError('UPSTREAM_ERROR', 'Generated image has an invalid size', false);
    }
    const mimeType = detectImageMimeType(data);
    if (!mimeType) {
      throw new ImageGenerationError('UPSTREAM_ERROR', 'Generated response was not a supported image', false);
    }
    return { data, mimeType };
  } catch (error) {
    if (error instanceof ImageGenerationError) throw error;
    throw new ImageGenerationError(
      'UPSTREAM_ERROR',
      error instanceof Error ? error.message : 'Replicate image request failed',
      true,
    );
  }
}
