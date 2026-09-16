import type { SeedreamInput, SeedreamProvider } from '../types.js';
import { fetchAsDataUrl, fetchRetry } from '../util.js';

/**
 * WaveSpeed REST API — async: POST /api/v3/{model} returns a prediction id,
 * then GET /api/v3/predictions/{id}/result until status=completed.
 * Image inputs accept URLs or base64 strings, so data URLs are sent directly.
 */

/** aspect_ratio enum of bytedance/seedream-v5.0-pro/edit on WaveSpeed. */
const RATIOS: Array<[string, number]> = [
  ['1:1', 1],
  ['1:2', 1 / 2],
  ['2:1', 2],
  ['1:3', 1 / 3],
  ['3:1', 3],
  ['2:3', 2 / 3],
  ['3:2', 3 / 2],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['4:5', 4 / 5],
  ['5:4', 5 / 4],
  ['9:16', 9 / 16],
  ['16:9', 16 / 9],
  ['9:21', 9 / 21],
  ['21:9', 21 / 9],
];

function nearestRatio(width: number, height: number): string {
  const r = width / height;
  let best = RATIOS[0];
  for (const c of RATIOS) if (Math.abs(Math.log(c[1] / r)) < Math.abs(Math.log(best[1] / r))) best = c;
  return best[0];
}

interface WsEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}
interface WsTask {
  id: string;
  status?: string;
  outputs?: string[];
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseUrl() {
  return (process.env.WAVESPEED_BASE_URL || 'https://api.wavespeed.ai/api/v3').replace(/\/$/, '');
}

function apiKey(): string {
  const key = process.env.WAVESPEED_API_KEY;
  if (!key) throw new Error('WAVESPEED_API_KEY is not set (server/.env)');
  return key;
}

/** Submits a task to any WaveSpeed model and waits for its first output, returned as a data URL. */
export async function wavespeedRun(model: string, body: Record<string, unknown>, timeoutMs = 180000): Promise<string> {
  const key = apiKey();
  const base = baseUrl();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

  const submit = await fetchRetry(`${base}/${model}`, { method: 'POST', headers, body: JSON.stringify(body) }, 3, 'WaveSpeed submit');
  const submitJson = (await submit.json().catch(() => ({}))) as WsEnvelope<WsTask> & WsTask;
  if (!submit.ok) throw new Error(`WaveSpeed submit ${submit.status}: ${submitJson.message || JSON.stringify(submitJson)}`);
  const task = submitJson.data ?? submitJson;
  if (!task?.id) throw new Error(`WaveSpeed returned no prediction id: ${JSON.stringify(submitJson)}`);
  console.log(`[wavespeed] ${model} task ${task.id}`);

  const started = Date.now();
  let delay = 1200;
  let netFailures = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(delay);
    delay = Math.min(3000, delay + 400);
    let res: Response;
    try {
      res = await fetch(`${base}/predictions/${task.id}/result`, { headers: { Authorization: `Bearer ${key}` } });
      netFailures = 0;
    } catch (e) {
      // Transient network hiccup while polling — the task keeps running server-side, so keep polling.
      netFailures += 1;
      console.warn(`[wavespeed] poll network error ${netFailures}/6: ${(e as Error).message}`);
      if (netFailures >= 6) throw new Error(`WaveSpeed poll: ${(e as Error).message}`);
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as WsEnvelope<WsTask> & WsTask;
    if (!res.ok) throw new Error(`WaveSpeed poll ${res.status}: ${json.message || JSON.stringify(json)}`);
    const result = json.data ?? json;
    switch (result.status) {
      case 'completed': {
        const out = result.outputs?.[0];
        if (!out) throw new Error('WaveSpeed completed without outputs');
        if (out.startsWith('http')) return fetchAsDataUrl(out);
        if (out.startsWith('data:')) return out;
        return `data:image/png;base64,${out}`;
      }
      case 'failed':
      case 'cancelled':
      case 'timeout':
      case 'deleted':
        throw new Error(`WaveSpeed task ${result.status}: ${result.error || ''}`.trim());
      default:
        break;
    }
  }
  throw new Error('WaveSpeed task timed out');
}

export function createWaveSpeedProvider(): SeedreamProvider {
  const model = process.env.WAVESPEED_SEEDREAM_MODEL || 'bytedance/seedream-v5.0-pro/edit';
  return {
    name: `wavespeed:${model}`,
    edit(input: SeedreamInput): Promise<string> {
      return wavespeedRun(model, {
        prompt: input.prompt,
        images: input.images,
        aspect_ratio: nearestRatio(input.width, input.height),
        resolution: process.env.WAVESPEED_RESOLUTION || '2k',
        output_format: 'png',
        prompt_optimization_mode: 'standard',
        enable_safety_checker: false,
      });
    },
  };
}

/** Background removal on WaveSpeed (transparent PNG). */
export function wavespeedRemoveBackground(imageDataUrl: string): Promise<string> {
  const model = process.env.WAVESPEED_BG_MODEL || 'wavespeed-ai/image-background-remover';
  return wavespeedRun(model, { image: imageDataUrl, enable_base64_output: false }, 120000);
}
