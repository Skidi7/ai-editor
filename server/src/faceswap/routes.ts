import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type Response } from 'express';
import { hasWaveSpeedKey, wavespeedRunRaw, wavespeedUpload } from '../providers/wavespeed.js';
import { fetchRetry, parseDataUrl } from '../util.js';
import { saveBuffer, storeRemote } from '../video/storage.js';
import { HttpError } from '../voice/errors.js';

/**
 * Face Swap (head swap) with the BFS "Best Face Swap" LoRA for Qwen-Image 2.1
 * (https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap, docs/qwen-image-2.1.md):
 *   picture 1 = the photo whose person gets the new head (it becomes the output frame),
 *   picture 2 = the new head (face / head-and-shoulders crop), prompt = the LoRA's trigger text, strength 1.0.
 *
 *   GET  /health          provider, model, LoRA, prices, budget
 *   GET  /vision/:file    in-browser models for the page: MediaPipe face landmarker and hair segmenter (head crop,
 *                         small-face zoom, the head-and-hair mask the answer is pasted back through, size check)
 *   POST /run             { mode?, target, head, head2?, resolution, aspect?, variants, seed?, strength?, tokens?, version?, extra? } → N images
 *
 * mode "body": BFS Body Swap V1.0 for Qwen Image 2.1 (docs/qwen-image-2.1-body.md): the whole person of picture 1
 * (face, clothes, body shape) is replaced by the person of picture 2, keeping the scene's pose, framing, light and
 * background. Same model and price, its own LoRA and trigger.
 *   POST /normalize       { person, tokens? } → the author's optional pass for Body Swap references that are not in the
 *                         trained format: plain Qwen Image 2.1 (no LoRA), 1024 × 1024, "full body studio reference photo…"
 *                         — $0.03, only when the page asks for it.
 */

export type FaceSwapProvider = 'wavespeed' | 'mock';

export function faceSwapProvider(): FaceSwapProvider {
  const p = (process.env.FACESWAP_PROVIDER || '').toLowerCase();
  if (p === 'mock') return 'mock';
  if (p === 'wavespeed') return 'wavespeed';
  return hasWaveSpeedKey() ? 'wavespeed' : 'mock';
}

const isMock = () => faceSwapProvider() === 'mock';

const MODEL = () => process.env.WAVESPEED_QWEN_EDIT_LORA_MODEL || 'wavespeed-ai/qwen-image-2.1/edit-lora';
/** Plain Qwen-Image 2.1 edit (no LoRA): the Body Swap reference normalisation pass. */
const EDIT_MODEL = () => process.env.WAVESPEED_QWEN_EDIT_MODEL || 'wavespeed-ai/qwen-image-2.1/edit';
/**
 * BFS head LoRA versions for Qwen-Image 2.1 (docs/qwen-image-2.1.md): V1 softens skin (its img_mlp.gate_up path);
 * V1.1 drops that path in blocks 16-31 (recommended: sharper skin, same pose / gaze copying); V1.1 alternative scales
 * the whole MLP path to 35% (more skin detail, stronger expression copying, ~1° more head-pose error).
 */
export const LORA_VERSIONS = {
  'v1.1': 'bfs_head_v1.1_qwen_2.1.safetensors',
  'v1.1-alt': 'bfs_head_v1.1_alternative_qwen_2.1.safetensors',
  v1: 'bfs_head_v1_qwen_2.1.safetensors',
} as const;
type LoraVersion = keyof typeof LORA_VERSIONS;
const LORA_BASE = () => (process.env.FACESWAP_LORA_BASE || 'https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap/resolve/main/').replace(/\/?$/, '/');
const LORA = (v: LoraVersion = 'v1.1') => `${LORA_BASE()}${LORA_VERSIONS[v]}`;
const BODY_LORA = () => `${LORA_BASE()}bfs_body_swap_v1.0_qwen_2.1.safetensors`;

export type SwapMode = 'head' | 'body';

type Resolution = '1k' | '1.5k' | '2k';
const RESOLUTIONS: Resolution[] = ['1k', '1.5k', '2k'];

/**
 * WaveSpeed price of one output image (POST /api/v3/model/price): base by tier + each input picture after the first
 * + the LoRA surcharge. Two pictures with the LoRA: 1K $0.045, 1.5K $0.08, 2K $0.145.
 */
export const PRICES = {
  base: { '1k': 0.03, '1.5k': 0.06, '2k': 0.12 } as Record<Resolution, number>,
  perExtraImage: { '1k': 0.01, '1.5k': 0.015, '2k': 0.02 } as Record<Resolution, number>,
  lora: 0.005,
};

export function runPrice(resolution: Resolution, pictures = 2): number {
  return Math.round((PRICES.base[resolution] + (pictures - 1) * PRICES.perExtraImage[resolution] + PRICES.lora) * 10000) / 10000;
}

/**
 * The LoRA's trigger prompt, verbatim from the author's Qwen 2.1 workflow. There "<image1>" / "<image2>" are ComfyUI's
 * placeholders bound to the input images; WaveSpeed binds its images to "<Picture 1>"… ("Refer to references as
 * <Picture 1> through <Picture 10>"), so "picture" (the default) is the same prompt for WaveSpeed. With "<image1>" the
 * model gets plain text and cannot tell which picture is the scene (the pose then comes from either).
 */
export function triggerPrompt(tokens: 'image' | 'picture'): string {
  const a = tokens === 'picture' ? '<Picture 1>' : '<image1>';
  const b = tokens === 'picture' ? '<Picture 2>' : '<image2>';
  return (
    `head_swap: start with ${a} as the base image, keeping its lighting, environment, and background. ` +
    `remove the head from ${a} completely and replace it with the head from ${b}, strictly preserving the hair, eye color, nose structure from ${b}. ` +
    `copy the direction of the eye, head rotation, micro expressions from ${a}, high quality, sharp details, 4k`
  );
}

/**
 * The Body Swap trigger, verbatim from the author's "Body Swap Qwen Image 2.1 - V1" workflow (= the Civitai trained
 * words): picture 1 is the scene, picture 2 the new person.
 */
export function bodyPrompt(tokens: 'image' | 'picture'): string {
  const a = tokens === 'picture' ? '<Picture 1>' : '<image1>';
  const b = tokens === 'picture' ? '<Picture 2>' : '<image2>';
  return (
    `body_swap: start with ${a} as the base image, keeping its lighting, environment, and background. ` +
    `replace the body from ${a} with the body from ${b}, strictly preserving the clothing, body shape and proportions from ${b}. ` +
    `strictly replicate the exact pose, arm positions, leg positions, hand gestures, head rotation, eye direction and micro expressions from ${a}`
  );
}

/**
 * The author's normalisation prompt (docs/qwen-image-2.1-body.md, "Normalize the reference first if it is not full
 * body"), verbatim: turns a portrait into a reference in the format the Body Swap LoRA was trained on.
 */
export function normalizePrompt(tokens: 'image' | 'picture'): string {
  const a = tokens === 'picture' ? '<Picture 1>' : '<image1>';
  return (
    `full body studio reference photo of the person from ${a}: standing upright on both feet, facing the camera, front view, camera at chest height ` +
    'and perfectly level, arms relaxed at the sides, neutral expression, looking straight at the camera. plain seamless light background, soft even ' +
    'studio lighting, no props and no cast shadows on the backdrop. the person fills almost the whole height of the square frame, from the top of the ' +
    `head down to the shoes, with a small even margin above and below. strictly keep the same face, hairstyle, clothing and body proportions as ${a}. ` +
    'sharp photographic detail'
  );
}

/**
 * Two people in one generation (Body Swap with a second reference, picture 3): the trigger with the people named by
 * side. The LoRA was trained on one person per reference, so this is the author's trigger stretched to two.
 */
export function bodyPromptTwo(tokens: 'image' | 'picture'): string {
  const a = tokens === 'picture' ? '<Picture 1>' : '<image1>';
  const b = tokens === 'picture' ? '<Picture 2>' : '<image2>';
  const c = tokens === 'picture' ? '<Picture 3>' : '<image3>';
  return (
    `body_swap: start with ${a} as the base image, keeping its lighting, environment, and background. ` +
    `replace the body of the person on the left in ${a} with the body from ${b}, and the body of the person on the right in ${a} with the body from ${c}, ` +
    `strictly preserving the clothing, body shape and proportions from ${b} and ${c}. ` +
    `strictly replicate the exact pose, arm positions, leg positions, hand gestures, head rotation, eye direction and micro expressions of both people from ${a}`
  );
}

/** One picture at 1K, no LoRA. */
export const NORMALIZE_PRICE = 0.03;

const ASPECTS = new Set(['1:1', '1:2', '2:1', '1:3', '3:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9']);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dataDir = () => process.env.FACESWAP_DATA_DIR || path.resolve(HERE, '../../data');

function fail(res: Response, e: unknown, extra: { status?: number; noRetry?: boolean } = {}) {
  const err = e as Error & { status?: number };
  const status = extra.status ?? err.status ?? 500;
  // Never show server paths to the page.
  const msg = (err.message || String(e)).replace(/[A-Za-z]:\\[^\s'"]+|(?:\/[\w.-]+){3,}/g, '…');
  console.error('[faceswap]', status, err.message);
  res.status(status).json({ error: msg, noRetry: extra.noRetry || undefined });
}

// ---------- Spend guard ----------

/**
 * Every paid call reserves its price first: an optional daily budget for the whole server (FACESWAP_DAILY_BUDGET_USD;
 * not set = no limit) and a per-client request rate (FACESWAP_RATE_PER_MINUTE, default 20). Variants that fail give
 * their share back.
 */
const spend = { day: '', total: 0 };
const hits = new Map<string, number[]>();
const spendFile = () => path.join(dataDir(), 'faceswap-spend.json');

try {
  const saved = JSON.parse(readFileSync(spendFile(), 'utf8')) as { day?: unknown; total?: unknown };
  if (typeof saved.day === 'string' && typeof saved.total === 'number') Object.assign(spend, saved);
} catch {
  /* first run */
}
let spendTimer: NodeJS.Timeout | undefined;
function saveSpend() {
  clearTimeout(spendTimer);
  spendTimer = setTimeout(() => {
    void fs
      .mkdir(dataDir(), { recursive: true })
      .then(() => fs.writeFile(spendFile(), JSON.stringify(spend)))
      .catch(() => undefined);
  }, 500);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Infinity = no limit (the variable not set). */
const dailyBudget = () => envNumber('FACESWAP_DAILY_BUDGET_USD', Infinity);

function spentToday(): number {
  const day = new Date().toISOString().slice(0, 10);
  if (spend.day !== day) {
    spend.day = day;
    spend.total = 0;
  }
  return spend.total;
}

/** Reserves `cost`; returns a function that gives back `part` of it (default: all that is still reserved). */
function reserve(req: Request, cost: number): (part?: number) => void {
  if (isMock() || cost <= 0) return () => undefined;
  if (spentToday() + cost > dailyBudget()) throw new HttpError(429, `Дневной бюджет $${dailyBudget()} исчерпан (FACESWAP_DAILY_BUDGET_USD)`);
  const who = req.ip || req.socket.remoteAddress || 'local';
  const now = Date.now();
  if (hits.size > 500) for (const [k, times] of hits) if (!times.some((t) => now - t < 60000)) hits.delete(k);
  const recent = (hits.get(who) || []).filter((t) => now - t < 60000);
  if (recent.length >= envNumber('FACESWAP_RATE_PER_MINUTE', 20)) throw new HttpError(429, 'Слишком много запросов: подождите минуту');
  recent.push(now);
  hits.set(who, recent);
  spend.total += cost;
  saveSpend();
  let left = cost;
  return (part = left) => {
    const back = Math.min(left, part);
    if (back <= 0) return;
    left -= back;
    spend.total = Math.max(0, spend.total - back);
    saveSpend();
  };
}

// ---------- Input images ----------

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Pixel size from the file header (PNG, JPEG, WebP); null when it cannot be read. */
function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) return null;
      const marker = b[off + 1];
      if (marker === 0xff) {
        off += 1;
        continue;
      }
      const len = b.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** The file ends the way its format says it must (a header glued to garbage is not an image). */
function completeImage(b: Buffer, mime: string): boolean {
  if (mime === 'image/png') return b.includes('IEND', Math.max(0, b.length - 64), 'latin1');
  if (mime === 'image/jpeg') {
    for (let i = b.length - 2; i >= Math.max(2, b.length - 4096); i--) if (b[i] === 0xff && b[i + 1] === 0xd9) return true;
    return false;
  }
  return b.readUInt32LE(4) + 8 <= b.length + 1;
}

interface InputImage {
  buffer: Buffer;
  mime: string;
  width: number;
  height: number;
}

function inputImage(v: unknown, field: string): InputImage {
  if (typeof v !== 'string' || !v.startsWith('data:image/')) throw new HttpError(400, `"${field}" must be an image data URL`);
  let parsed: { mime: string; buffer: Buffer };
  try {
    parsed = parseDataUrl(v);
  } catch {
    throw new HttpError(400, `"${field}" is not a valid data URL`);
  }
  const { mime, buffer } = parsed;
  if (!IMAGE_TYPES.has(mime)) throw new HttpError(415, `"${field}": PNG, JPEG or WebP only`);
  if (buffer.length > MAX_IMAGE_BYTES) throw new HttpError(413, `"${field}" is too large (up to 15 MB)`);
  const size = imageSize(buffer);
  if (!size || !completeImage(buffer, mime)) throw new HttpError(415, `"${field}" is not a readable image`);
  if (Math.min(size.width, size.height) < 256 || Math.max(size.width, size.height) > 4096) {
    throw new HttpError(400, `"${field}" must be 256..4096 px per side (got ${size.width}×${size.height})`);
  }
  return { buffer, mime, ...size };
}

/** First output of a finished prediction as a URL / data URL / bare base64 string. */
function outputUrl(outputs: unknown[]): string {
  const out = outputs[0];
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    const u = (out as Record<string, unknown>).url ?? (out as Record<string, unknown>).image;
    if (typeof u === 'string') return u;
  }
  throw new Error(`Unexpected WaveSpeed output: ${JSON.stringify(out).slice(0, 200)}`);
}

async function saveOutput(out: string): Promise<string> {
  if (/^https?:\/\//.test(out)) return (await storeRemote(out, 'faceswap', 'image/png')).url;
  const dataUrl = out.startsWith('data:') ? out : `data:image/png;base64,${out}`;
  const { mime, buffer } = parseDataUrl(dataUrl);
  return (await saveBuffer(buffer, mime, 'faceswap')).url;
}

// ---------- In-browser face and hair finder ----------

/**
 * Models the page runs in the browser (free, nothing is sent anywhere): the MediaPipe face landmarker (head crop of
 * the face photo, small-face zoom, size check) and the MediaPipe selfie multiclass segmenter (hair: the mask the
 * answer is pasted back through, the whole hairstyle in the head crop). The wasm runtime comes from the installed
 * @mediapipe/tasks-vision package; each model is downloaded once (a Hugging Face copy, checked against the official
 * file's SHA-256; Google's storage as a fallback) and cached in server/data/vision-models.
 */
const VISION_MODELS: Record<string, { sha256: string; sources: string[] }> = {
  'face_landmarker.task': {
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    sources: [
      'https://huggingface.co/VLAAADYAAA/face-landmarker-task-model/resolve/main/face_landmarker.task',
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    ],
  },
  'selfie_multiclass_256x256.tflite': {
    sha256: 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0',
    sources: [
      'https://huggingface.co/yolain/selfie_multiclass_256x256/resolve/main/selfie_multiclass_256x256.tflite',
      'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
    ],
  },
};
const VISION_WASM = new Set(['vision_wasm_internal.js', 'vision_wasm_internal.wasm']);
const visionDir = () => process.env.FACESWAP_VISION_DIR || path.join(dataDir(), 'vision-models');
const downloads = new Map<string, Promise<string>>();

async function visionModel(name: string): Promise<string> {
  const spec = VISION_MODELS[name];
  const file = path.join(visionDir(), name);
  try {
    await fs.access(file);
    return file;
  } catch {
    /* not cached yet */
  }
  let pending = downloads.get(name);
  if (!pending) {
    pending = (async () => {
      const errors: string[] = [];
      for (const url of spec.sources) {
        try {
          const res = await fetchRetry(url, undefined, 2, `download ${name}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          const sha = createHash('sha256').update(buffer).digest('hex');
          if (sha !== spec.sha256) throw new Error(`checksum mismatch (${sha.slice(0, 12)}…)`);
          await fs.mkdir(visionDir(), { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          await fs.writeFile(tmp, buffer);
          await fs.rename(tmp, file);
          console.log(`[faceswap] cached vision model ${name} (${Math.round(buffer.length / 1024)} KB) from ${new URL(url).host}`);
          return file;
        } catch (e) {
          errors.push(`${new URL(url).host}: ${(e as Error).message}`);
        }
      }
      throw new Error(`Could not download ${name}: ${errors.join('; ')}`);
    })().finally(() => downloads.delete(name));
    downloads.set(name, pending);
  }
  return pending;
}

// ---------- Router ----------

export function createFaceSwapRouter(): Router {
  const r = Router();

  r.use((req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) return void res.status(415).json({ error: 'Send the request as JSON' });
    next();
  });

  r.get('/health', (_req, res) => {
    res.json({
      provider: faceSwapProvider(),
      model: MODEL(),
      lora: LORA(),
      bodyLora: BODY_LORA(),
      normalizePrice: NORMALIZE_PRICE,
      versions: Object.keys(LORA_VERSIONS),
      prices: { '1k': runPrice('1k'), '1.5k': runPrice('1.5k'), '2k': runPrice('2k') },
      pricesTwo: { '1k': runPrice('1k', 3), '1.5k': runPrice('1.5k', 3), '2k': runPrice('2k', 3) },
      budget: { daily: Number.isFinite(dailyBudget()) ? dailyBudget() : null, spentToday: Math.round(spentToday() * 10000) / 10000 },
    });
  });

  r.get('/vision/:file', async (req, res) => {
    const name = req.params.file;
    try {
      let file: string;
      const runtime = VISION_WASM.has(name);
      if (runtime) file = createRequire(import.meta.url).resolve(`@mediapipe/tasks-vision/${name}`);
      else if (Object.hasOwn(VISION_MODELS, name)) file = await visionModel(name);
      else return void res.status(404).json({ error: 'Unknown file' });
      const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      res.setHeader('Content-Type', type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', `public, max-age=${runtime ? 86400 : 30 * 86400}`);
      res.sendFile(file);
    } catch (e) {
      fail(res, e, { status: 502 });
    }
  });

  /** One swap = `variants` predictions of Qwen-Image 2.1 edit-lora with the BFS LoRA, each with its own seed. */
  /** Body Swap reference → full body, facing the camera, plain light background (the author's optional pass). */
  r.post('/normalize', async (req, res) => {
    let release: (part?: number) => void = () => undefined;
    let paid = false;
    try {
      const b = req.body ?? {};
      const person = inputImage(b.person, 'person');
      // WaveSpeed binds its images to "<Picture N>" (its API docs); "<image1>" is the author's ComfyUI placeholder.
      const tokens = b.tokens === 'image' ? 'image' : 'picture';
      if (isMock()) {
        await new Promise((r2) => setTimeout(r2, 500));
        res.json({ url: (await saveBuffer(person.buffer, person.mime, 'faceswap-normalize-mock')).url, cost: 0, mock: true });
        return;
      }
      release = reserve(req, NORMALIZE_PRICE);
      console.log(`[faceswap] normalize ${EDIT_MODEL()} 1k 1:1 $${NORMALIZE_PRICE.toFixed(3)}`);
      const url = await wavespeedUpload(person.buffer, `person.${person.mime === 'image/png' ? 'png' : 'jpg'}`, person.mime);
      const body = { prompt: normalizePrompt(tokens), images: [url], resolution: '1k', aspect_ratio: '1:1', output_format: 'png', seed: Math.floor(Math.random() * 2147483647) };
      const outputs = await wavespeedRunRaw(EDIT_MODEL(), body, 300000);
      paid = true;
      res.json({ url: await saveOutput(outputUrl(outputs)), cost: NORMALIZE_PRICE });
    } catch (e) {
      if (paid) return fail(res, e, { status: 502, noRetry: true });
      release();
      fail(res, e);
    }
  });

  r.post('/run', async (req, res) => {
    let release: (part?: number) => void = () => undefined;
    try {
      const b = req.body ?? {};
      const resolution: Resolution = RESOLUTIONS.includes(b.resolution) ? b.resolution : '2k';
      const variants = b.variants === undefined ? 1 : Number(b.variants);
      if (!Number.isInteger(variants) || variants < 1 || variants > 4) throw new HttpError(400, '"variants": 1..4');
      const aspect = typeof b.aspect === 'string' && ASPECTS.has(b.aspect) ? b.aspect : undefined;
      const seed = b.seed === undefined || b.seed === null || b.seed === '' ? -1 : Math.round(Number(b.seed));
      if (!Number.isFinite(seed) || seed < -1 || seed > 2147483647) throw new HttpError(400, '"seed": 0..2147483647');
      const strength = b.strength === undefined ? 1 : Number(b.strength);
      if (!Number.isFinite(strength) || strength < 0.5 || strength > 1.6) throw new HttpError(400, '"strength": 0.5..1.6');
      // WaveSpeed binds its images to "<Picture N>" (its API docs); "<image1>" is the author's ComfyUI placeholder.
      const tokens = b.tokens === 'image' ? 'image' : 'picture';
      const mode: SwapMode = b.mode === 'body' ? 'body' : 'head';
      const version: LoraVersion = typeof b.version === 'string' && Object.hasOwn(LORA_VERSIONS, b.version) ? (b.version as LoraVersion) : 'v1.1';
      // The page adds the hairstyle in words (from the hair masks) plus up to 200 characters of the user's own.
      const extra = typeof b.extra === 'string' ? b.extra.replace(/\s+/g, ' ').trim().slice(0, 700) : '';

      const target = inputImage(b.target, 'target');
      const head = inputImage(b.head, 'head');
      // Body Swap of two people at once: the second reference (the person on the right) as picture 3.
      const head2 = mode === 'body' && b.head2 ? inputImage(b.head2, 'head2') : null;
      // The author notes details (expression etc.) can follow the trigger prompt.
      const trigger = mode === 'body' ? (head2 ? bodyPromptTwo(tokens) : bodyPrompt(tokens)) : triggerPrompt(tokens);
      const prompt = extra ? `${trigger}. ${extra}` : trigger;
      const lora = mode === 'body' ? BODY_LORA() : LORA(version);
      const pictures = head2 ? [target, head, head2] : [target, head];
      const each = runPrice(resolution, pictures.length);
      const model = MODEL();
      const seeds = Array.from({ length: variants }, (_, i) => (seed >= 0 ? (seed + i) % 2147483648 : Math.floor(Math.random() * 2147483647)));

      if (isMock()) {
        await new Promise((r2) => setTimeout(r2, 700));
        const url = (await saveBuffer(target.buffer, target.mime, 'faceswap-mock')).url;
        res.json({ results: seeds.map((s) => ({ url, seed: s })), cost: 0, each: 0, prompt, model, resolution, mock: true });
        return;
      }

      release = reserve(req, each * variants);
      console.log(`[faceswap] ${mode}${head2 ? ' ×2 people' : ''} ${model} ×${variants} ${resolution} lora ${mode === 'body' ? 'body v1.0' : version} ${strength} $${(each * variants).toFixed(3)}`);
      const urls = await Promise.all(
        pictures.map((p, i) => wavespeedUpload(p.buffer, `faceswap-${i}.${p.mime === 'image/png' ? 'png' : p.mime === 'image/webp' ? 'webp' : 'jpg'}`, p.mime)),
      );
      const results = await Promise.all(
        seeds.map(async (s) => {
          const body: Record<string, unknown> = { prompt, images: urls, resolution, output_format: 'png', seed: s, loras: [{ path: lora, scale: strength }] };
          if (aspect) body.aspect_ratio = aspect;
          let outputs: unknown[];
          try {
            outputs = await wavespeedRunRaw(model, body, 300000);
          } catch (e) {
            release(each);
            return { seed: s, error: (e as Error).message };
          }
          try {
            return { seed: s, url: await saveOutput(outputUrl(outputs)) };
          } catch (e) {
            // Already paid: the prediction finished, only the download failed.
            return { seed: s, error: `Результат готов, но не скачался: ${(e as Error).message}`, paid: true };
          }
        }),
      );
      const ok = results.filter((x) => 'url' in x || x.paid).length;
      if (!results.some((x) => 'url' in x)) {
        fail(res, new Error((results[0] as { error: string }).error), { status: 502, noRetry: ok > 0 });
        return;
      }
      res.json({ results, cost: Math.round(each * ok * 10000) / 10000, each, prompt, model, resolution });
    } catch (e) {
      release();
      fail(res, e);
    }
  });

  return r;
}
