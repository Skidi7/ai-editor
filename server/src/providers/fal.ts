import { fal } from '@fal-ai/client';
import type { SeedreamInput, SeedreamProvider } from '../types.js';
import { dataUrlToBlob, fetchAsDataUrl, fitSeedreamSize } from '../util.js';

interface FalImage {
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

interface FalEditOutput {
  images: FalImage[];
}

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('FAL_KEY is not set');
  fal.config({ credentials: key });
  configured = true;
}

/** Uploads a data URL to fal storage and returns a public URL (keeps request bodies small). */
async function upload(dataUrl: string): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const ext = blob.type === 'image/jpeg' ? 'jpg' : 'png';
  const file = new File([blob], `input.${ext}`, { type: blob.type });
  return fal.storage.upload(file);
}

export function createFalProvider(): SeedreamProvider {
  const model = process.env.SEEDREAM_FAL_MODEL || 'bytedance/seedream/v5/pro/edit';
  return {
    name: `fal:${model}`,
    async edit(input: SeedreamInput): Promise<string> {
      ensureConfigured();
      const image_urls = await Promise.all(input.images.map(upload));
      const image_size = fitSeedreamSize(input.width, input.height);
      const result = await fal.subscribe(model, {
        input: {
          prompt: input.prompt,
          image_urls,
          image_size,
          num_images: 1,
          output_format: 'png',
          enable_safety_checker: false,
        },
        logs: false,
      });
      const data = result.data as FalEditOutput;
      const first = data?.images?.[0];
      if (!first?.url) throw new Error('fal returned no image');
      return fetchAsDataUrl(first.url);
    },
  };
}

/** Background removal through fal (BiRefNet v2). */
export async function falRemoveBackground(imageDataUrl: string): Promise<string> {
  ensureConfigured();
  const model = process.env.BG_REMOVAL_FAL_MODEL || 'fal-ai/birefnet/v2';
  const image_url = await upload(imageDataUrl);
  const result = await fal.subscribe(model, {
    input: { image_url, output_format: 'png', model: 'General Use (Heavy)' },
    logs: false,
  });
  const data = result.data as { image?: FalImage; images?: FalImage[] };
  const url = data?.image?.url || data?.images?.[0]?.url;
  if (!url) throw new Error('fal returned no image');
  return fetchAsDataUrl(url);
}
