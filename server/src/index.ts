import 'dotenv/config';
import { configureNetwork } from './proxy.js';
// Must run before any outbound fetch: connect timeouts and optional proxy for WaveSpeed calls.
configureNetwork();
import express from 'express';
import cors from 'cors';
import type { EditRequest, ExpandRequest, ImageResult, ReplaceBackgroundRequest, SeedreamProvider } from './types.js';
import { createFalProvider, falRemoveBackground } from './providers/fal.js';
import { createArkProvider } from './providers/ark.js';
import { createMockProvider } from './providers/mock.js';
import { createWaveSpeedProvider, wavespeedRemoveBackground } from './providers/wavespeed.js';
import { EXPAND_PROMPT, buildGlobalEditPrompt, buildMaskedEditPrompt, buildRelightPrompt, buildReplaceBackgroundPrompt, type RelightParams } from './prompts.js';
import { fetchAsDataUrl } from './util.js';
import { createVideoRouter, videoProvider } from './video/routes.js';
import { ensureMediaDir, mediaDir } from './video/storage.js';
import { createVoiceRouter, voiceProvider } from './voice/routes.js';
import { createFaceSwapRouter, faceSwapProvider } from './faceswap/routes.js';

const app = express();
// The app is used through the Vite proxy (same origin). Cross-origin calls are allowed only from local pages, so no
// website can spend the WaveSpeed key through a visitor's browser. CORS_ORIGINS adds more (comma-separated).
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const extraOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOrigin = (origin: string) => LOCAL_ORIGIN.test(origin) || extraOrigins.includes(origin);
const allowedHosts = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  ...(process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
]);
// Every request must name this server by a local host name (stops DNS rebinding; a deployment with HOST set lists its
// names in ALLOWED_HOSTS) and, when a browser says which page sent it, come from an allowed page: CORS alone only hides
// the answer, it does not stop a plain cross-site form POST from running.
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const checkHost = !process.env.HOST || !!process.env.ALLOWED_HOSTS;
  if (checkHost && !allowedHosts.has(host)) return void res.status(403).json({ error: 'Unknown host' });
  const origin = req.headers.origin;
  if (origin && !allowedOrigin(origin)) return void res.status(403).json({ error: 'Cross-site request refused' });
  next();
});
app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowedOrigin(origin)) }));
app.use(express.json({ limit: '200mb' }));

// Video Studio: generated / uploaded media (stills, takes, music) served from server/storage.
// Only media files are served, judged on the decoded path (no encoded dots, NTFS streams or trailing dots); sniffing
// is off and documents are sandboxed, so a stored file can never act as a page on our origin.
await ensureMediaDir();
const MEDIA_FILE = /\.(png|jpe?g|webp|gif|svg|mp4|m4v|webm|mov|mkv|avi|3gp|mp3|wav|m4a|aac|ogg|oga|weba|flac)$/i;
app.use('/media', (req, res, next) => {
  let file: string;
  try {
    file = decodeURIComponent(req.path);
  } catch {
    return void res.status(400).end();
  }
  if (!MEDIA_FILE.test(file) || /[%:\\]|[. ]$/.test(file)) return void res.status(404).end();
  next();
});
app.use(
  '/media',
  express.static(mediaDir(), {
    maxAge: '7d',
    etag: true,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox');
    },
  }),
);
app.use('/api/video', createVideoRouter());
// Voice Studio: voice library, speech (OmniVoice), voice design (Qwen3), voice capture / clone.
app.use('/api/voice', createVoiceRouter());
// Face Swap: head swap with the BFS LoRA on Qwen-Image 2.1 edit-lora (WaveSpeed).
app.use('/api/faceswap', createFaceSwapRouter());

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

// Malformed JSON and other body errors answer in JSON like every route, not with Express's HTML page.
app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.type === 'entity.parse.failed' ? 'Malformed JSON body' : err.message || 'Server error' });
});

const port = Number(process.env.PORT || 8787);
// Loopback only by default: the pages reach the API through the Vite proxy, and nobody else on the network may use
// the paid keys. HOST (e.g. 0.0.0.0) exposes it on purpose, for a deployment that has its own login in front.
const hosts = process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1'];
hosts.forEach((host, i) => {
  const server = app.listen(port, host, () => {
    if (i === 0) console.log(`[server] listening on http://localhost:${port}  seedream=${provider.name}  bg=${bgProvider()}  video=${videoProvider()}  voice=${voiceProvider()}  faceswap=${faceSwapProvider()}`);
  });
  server.on('error', (e) => {
    if (host === '::1') console.warn(`[server] IPv6 loopback unavailable: ${(e as Error).message}`);
    else throw e;
  });
});
