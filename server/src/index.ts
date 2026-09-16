import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import type { EditRequest, ExpandRequest, ImageResult, ReplaceBackgroundRequest, SeedreamProvider } from './types.js';
import { createFalProvider, falRemoveBackground } from './providers/fal.js';
import { createArkProvider } from './providers/ark.js';
import { createMockProvider } from './providers/mock.js';
import { createWaveSpeedProvider, wavespeedRemoveBackground } from './providers/wavespeed.js';
import { EXPAND_PROMPT, buildGlobalEditPrompt, buildMaskedEditPrompt, buildRelightPrompt, buildReplaceBackgroundPrompt, type RelightParams } from './prompts.js';
import { fetchAsDataUrl } from './util.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '120mb' }));

function makeProvider(): SeedreamProvider {
  switch ((process.env.SEEDREAM_PROVIDER || 'mock').toLowerCase()) {
    case 'fal':
      return createFalProvider();
    case 'ark':
      return createArkProvider();
    case 'wavespeed':
      return createWaveSpeedProvider();
    default:
      return createMockProvider();
  }
}
const provider = makeProvider();

type BgProvider = 'wavespeed' | 'fal' | 'client';
function bgProvider(): BgProvider {
  const p = (process.env.BG_REMOVAL_PROVIDER || 'client').toLowerCase();
  if (p === 'wavespeed' && process.env.WAVESPEED_API_KEY) return 'wavespeed';
  if (p === 'fal' && process.env.FAL_KEY) return 'fal';
  return 'client';
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, seedream: provider.name, backgroundRemoval: bgProvider() });
});

function validateImage(s: unknown, field: string) {
  if (typeof s !== 'string' || !s.startsWith('data:image/')) {
    throw new Error(`"${field}" must be an image data URL`);
  }
}

function fail(res: express.Response, e: unknown) {
  const msg = (e as Error).message || String(e);
  console.error('[api]', msg);
  res.status(500).json({ error: msg });
}

app.post('/api/edit', async (req, res) => {
  try {
    const body = req.body as EditRequest;
    validateImage(body.image, 'image');
    if (!body.prompt?.trim()) throw new Error('Prompt is empty');
    const images = [body.image];
    let prompt: string;
    if (body.marked) {
      validateImage(body.marked, 'marked');
      images.push(body.marked);
      prompt = buildMaskedEditPrompt(body.prompt, body.bbox);
    } else {
      prompt = buildGlobalEditPrompt(body.prompt);
    }
    const image = await provider.edit({ prompt, images, width: body.width, height: body.height });
    const out: ImageResult = { image, provider: provider.name };
    res.json(out);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/expand', async (req, res) => {
  try {
    // `width`/`height` here are the TARGET frame size: the provider derives the output aspect ratio from them.
    const body = req.body as ExpandRequest;
    validateImage(body.image, 'image');
    const image = await provider.edit({ prompt: EXPAND_PROMPT, images: [body.image], width: body.width, height: body.height });
    const out: ImageResult = { image, provider: provider.name };
    res.json(out);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/replace-background', async (req, res) => {
  try {
    const body = req.body as ReplaceBackgroundRequest;
    validateImage(body.image, 'image');
    if (!body.prompt?.trim()) throw new Error('Prompt is empty');
    const image = await provider.edit({
      prompt: buildReplaceBackgroundPrompt(body.prompt),
      images: [body.image],
      width: body.width,
      height: body.height,
    });
    const out: ImageResult = { image, provider: provider.name };
    res.json(out);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/relight', async (req, res) => {
  try {
    const body = req.body as { image: string; guide?: string; width: number; height: number; light: RelightParams };
    validateImage(body.image, 'image');
    if (!body.light) throw new Error('light settings missing');
    const images = [body.image];
    if (body.guide) {
      validateImage(body.guide, 'guide');
      images.push(body.guide);
    }
    const prompt = buildRelightPrompt(body.light, !!body.guide);
    const image = await provider.edit({ prompt, images, width: body.width, height: body.height });
    const out: ImageResult = { image, provider: provider.name };
    res.json(out);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/remove-background', async (req, res) => {
  try {
    const p = bgProvider();
    if (p === 'client') {
      res.status(501).json({ error: 'Server-side background removal is not configured', fallback: 'client' });
      return;
    }
    const { image } = req.body as { image: string };
    validateImage(image, 'image');
    const result = p === 'wavespeed' ? await wavespeedRemoveBackground(image) : await falRemoveBackground(image);
    const out: ImageResult = { image: result, provider: p };
    res.json(out);
  } catch (e) {
    fail(res, e);
  }
});

/** Proxies a remote image (e.g. dragged from another browser tab) so the canvas is not tainted by CORS. */
app.get('/api/fetch-image', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!/^https?:\/\//.test(url)) throw new Error('url must be http(s)');
    const image = await fetchAsDataUrl(url);
    if (!image.startsWith('data:image/')) throw new Error('URL is not an image');
    res.json({ image });
  } catch (e) {
    fail(res, e);
  }
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}  seedream=${provider.name}  bg=${bgProvider()}`);
});
