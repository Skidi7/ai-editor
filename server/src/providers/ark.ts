import type { SeedreamInput, SeedreamProvider } from '../types.js';
import { fetchAsDataUrl, fitSeedreamSize } from '../util.js';

interface ArkResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { code?: string; message?: string };
}

/**
 * BytePlus ModelArk / Volcengine Ark — POST {base}/images/generations
 * Body: { model, prompt, image: string | string[], size: "WxH", response_format, watermark }
 */
export function createArkProvider(): SeedreamProvider {
  const base = (process.env.ARK_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3').replace(/\/$/, '');
  const model = process.env.ARK_SEEDREAM_MODEL || 'dola-seedream-5-0-pro-260628';
  return {
    name: `ark:${model}`,
    async edit(input: SeedreamInput): Promise<string> {
      const key = process.env.ARK_API_KEY;
      if (!key) throw new Error('ARK_API_KEY is not set');
      const size = fitSeedreamSize(input.width, input.height);
      const body = {
        model,
        prompt: input.prompt,
        image: input.images.length === 1 ? input.images[0] : input.images,
        size: `${size.width}x${size.height}`,
        response_format: 'b64_json',
        watermark: false,
        sequential_image_generation: 'disabled',
      };
      const res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as ArkResponse;
      if (!res.ok || json.error) {
        throw new Error(`Ark error ${res.status}: ${json.error?.message || JSON.stringify(json)}`);
      }
      const first = json.data?.[0];
      if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
      if (first?.url) return fetchAsDataUrl(first.url);
      throw new Error('Ark returned no image');
    },
  };
}
