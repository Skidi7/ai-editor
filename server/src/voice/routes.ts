import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { Router, type Request, type Response } from 'express';
import { hasWaveSpeedKey, wavespeedRunRaw, wavespeedUpload } from '../providers/wavespeed.js';
import { fetchRetry, parseDataUrl } from '../util.js';
import { parseWhisperSegments } from '../video/align.js';
import { createJob, getJob, publicJob } from '../video/jobs.js';
import { extToMime, isMediaUrl, mediaPath, mimeToExt, saveBuffer } from '../video/storage.js';
import { ffmpegAvailable } from '../video/transcode.js';
import { QWEN_LANGS, llmSpec, ruleSpec, type VoiceSpec } from './design.js';
import { HttpError } from './errors.js';
import { createCustom, dataDir, deleteCustom, listCustom, listPresets, presetsDir, savePresetAnchor, updateCustom, voiceReference } from './library.js';
import { babbleWav, hashString, mockPitch } from './mock.js';
import { PRESETS, findPreset } from './presets.js';
import { PRICES, isolatePrice, omniPrice, qwenPrice, whisperPrice } from './pricing.js';

/**
 * Voice Studio API.
 *   library             GET/POST/PATCH/DELETE /voices, built-in voice clips: POST /presets/prepare (job)
 *   speech in a voice   POST /speak        OmniVoice voice-clone: the voice's anchor clip + its exact text as reference
 *   new voice by words  POST /design       any-llm (description → English + sample phrase) → Qwen3 Voice Design
 *   voice from a file   POST /upload, /extract (ffmpeg fallback), /isolate (Audio Vocal Isolator), /transcribe (Whisper)
 */

export type VoiceProvider = 'wavespeed' | 'mock';

export function voiceProvider(): VoiceProvider {
  const p = (process.env.VOICE_PROVIDER || '').toLowerCase();
  if (p === 'mock') return 'mock';
  if (p === 'wavespeed') return 'wavespeed';
  return hasWaveSpeedKey() ? 'wavespeed' : 'mock';
}

const isMock = () => voiceProvider() === 'mock';

/** Built-in voices can be (re)made from the UI; set VOICE_PRESETS_EDITABLE=false wherever visitors are not admins. */
const presetsEditable = () => (process.env.VOICE_PRESETS_EDITABLE || 'true').toLowerCase() !== 'false';

const MODELS = {
  clone: () => process.env.WAVESPEED_OMNIVOICE_CLONE_MODEL || 'wavespeed-ai/omnivoice/voice-clone',
  design: () => process.env.WAVESPEED_QWEN_DESIGN_MODEL || 'wavespeed-ai/qwen3-tts/voice-design',
  isolate: () => process.env.WAVESPEED_VOCAL_ISOLATOR_MODEL || 'wavespeed-ai/audio-vocal-isolator',
  whisper: () => process.env.WAVESPEED_WHISPER_AUDIO_MODEL || 'wavespeed-ai/openai-whisper',
  llm: () => `${process.env.WAVESPEED_LLM_MODEL || 'wavespeed-ai/any-llm'} · ${process.env.VOICE_LLM || 'google/gemini-2.5-flash'}`,
};

const MAX_SPEAK_CHARS = 3000;

function fail(res: Response, e: unknown, extra: { status?: number; noRetry?: boolean } = {}) {
  const err = e as Error & { status?: number; code?: string };
  const status = extra.status ?? err.status ?? 500;
  let msg = err.message || String(e);
  if (err.code === 'ENOENT' || msg.includes('ENOENT')) msg = 'File not found on the server';
  // Never show server paths to the page.
  msg = msg.replace(/[A-Za-z]:\\[^\s'"]+|(?:\/[\w.-]+){3,}/g, '…');
  console.error('[voice]', status, err.message);
  res.status(status).json({ error: msg, noRetry: extra.noRetry || undefined });
}

/** A prediction that already finished is paid: a later failure (e.g. downloading its audio) must not be retried. */
function failAfterPaid(res: Response, e: unknown) {
  fail(res, e, { status: 502, noRetry: true });
}

function text(v: unknown, field: string, required = true): string {
  if (typeof v === 'string' && (!required || v.trim())) return v;
  if (!required && (v === undefined || v === null)) return '';
  throw new HttpError(400, `"${field}" is required`);
}

/** Something a voice can actually say: at least one letter or digit (not just punctuation or emoji). */
function speakable(s: string, field: string): string {
  if (!/[\p{L}\p{N}]/u.test(s)) throw new HttpError(400, `"${field}" has no words to speak`);
  return s;
}

/** Clips the voice models take (and the built-in voices are stored as). */
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|weba|webm|flac|mp4|mov|mkv|avi|3gp)$/i;
/** What the ffmpeg fallback may read: the above plus containers browsers cannot decode. */
const SOURCE_EXT = /\.(mp3|wav|m4a|aac|ogg|weba|webm|flac|mp4|mov|mkv|avi|3gp|wmv|asf|wma|flv|ts|mpg|aiff|amr|caf)$/i;

/** An uploaded audio / video file of ours: a /media URL with a media extension that exists. */
async function mediaAudio(v: unknown, field: string, ext = AUDIO_EXT): Promise<string> {
  const url = text(v, field);
  if (!isMediaUrl(url) || !ext.test(url.split('?')[0])) throw new HttpError(400, `"${field}" must be an uploaded audio file`);
  await fs.access(mediaPath(url)).catch(() => {
    throw new HttpError(404, 'The audio file is missing on the server');
  });
  return url;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------- Spend guard ----------

/**
 * Every paid call reserves its estimated price first: an optional daily budget for the whole server
 * (VOICE_DAILY_BUDGET_USD; not set = no limit) and a per-client request rate (VOICE_RATE_PER_MINUTE, default 40). The
 * rate stops a runaway loop; set the budget when strangers can reach the API. Failed calls give their reservation back.
 */
const spend = { day: '', total: 0 };
const hits = new Map<string, number[]>();
const spendFile = () => path.join(dataDir(), 'voice-spend.json');

// The day's spending survives restarts (tsx watch restarts on every save).
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

/** A non-negative number from the environment; 0 is a real value (0 = no paid calls at all). */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Infinity = no limit (the variable not set). */
function dailyBudget(): number {
  return envNumber('VOICE_DAILY_BUDGET_USD', Infinity);
}

function spentToday(): number {
  const day = new Date().toISOString().slice(0, 10);
  if (spend.day !== day) {
    spend.day = day;
    spend.total = 0;
  }
  return spend.total;
}

function reserve(req: Request | null, cost: number): () => void {
  if (isMock() || cost <= 0) return () => undefined;
  if (spentToday() + cost > dailyBudget()) throw new HttpError(429, `Today's budget of $${dailyBudget()} is used up (VOICE_DAILY_BUDGET_USD)`);
  if (req) {
    const who = req.ip || req.socket.remoteAddress || 'local';
    const now = Date.now();
    if (hits.size > 500) for (const [k, times] of hits) if (!times.some((t) => now - t < 60000)) hits.delete(k);
    const recent = (hits.get(who) || []).filter((t) => now - t < 60000);
    if (recent.length >= envNumber('VOICE_RATE_PER_MINUTE', 40)) throw new HttpError(429, 'Too many requests: wait a minute and try again');
    recent.push(now);
    hits.set(who, recent);
  }
  spend.total += cost;
  saveSpend();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    spend.total = Math.max(0, spend.total - cost);
    saveSpend();
  };
}

/** Longest clip the paid audio routes take: our fragments are at most 30 s. */
const MAX_CLIP_SEC = 120;

/**
 * Real length of a stored clip, for the price: exact for WAV (what the page uploads), a generous estimate from the
 * size for compressed files. The client's own figure is never trusted.
 */
async function mediaSeconds(url: string): Promise<number> {
  const file = mediaPath(url);
  const { size } = await fs.stat(file);
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 4096));
    await fh.read(head, 0, head.length, 0);
    if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') {
      let off = 12;
      let byteRate = 0;
      while (off + 8 <= head.length) {
        const id = head.toString('latin1', off, off + 4);
        const len = head.readUInt32LE(off + 4);
        if (id === 'fmt ' && off + 20 <= head.length) byteRate = head.readUInt32LE(off + 16);
        if (id === 'data' && byteRate) return Math.min(len, size - off - 8) / byteRate;
        off += 8 + len + (len % 2);
      }
    }
  } finally {
    await fh.close();
  }
  return size / 4000;
}

async function clipSeconds(url: string): Promise<number> {
  const seconds = await mediaSeconds(url);
  if (seconds > MAX_CLIP_SEC) throw new HttpError(400, 'The clip is too long: up to 2 minutes');
  return Math.max(1, seconds);
}

// ---------- WaveSpeed I/O ----------

/** WaveSpeed keeps uploads for 7 days: anchor clips are uploaded once and their URL reused for 6 days. */
const remoteCache = new Map<string, { url: string; at: number }>();
const REMOTE_TTL = 6 * 24 * 3600 * 1000;

async function remoteFileUrl(file: string): Promise<string> {
  const hit = remoteCache.get(file);
  if (hit && Date.now() - hit.at < REMOTE_TTL) return hit.url;
  const buffer = await fs.readFile(file);
  const url = await wavespeedUpload(buffer, path.basename(file), extToMime(path.extname(file).slice(1)));
  remoteCache.set(file, { url, at: Date.now() });
  return url;
}

function outputAt(outputs: unknown[], index: number): string {
  const out = outputs[index];
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    const u = o.url ?? o.audio ?? o.output;
    if (typeof u === 'string') return u;
  }
  throw new Error(`Unexpected WaveSpeed output: ${JSON.stringify(out).slice(0, 200)}`);
}

/** Downloads a generated clip (URL, data URL or bare base64). */
async function downloadAudio(outputs: unknown[], index = 0): Promise<{ buffer: Buffer; mime: string }> {
  const out = outputAt(outputs, index);
  if (out.startsWith('data:')) return parseDataUrl(out);
  if (!/^https?:\/\//.test(out)) {
    if (out.length < 200 || !/^[A-Za-z0-9+/=\s]+$/.test(out)) throw new Error(`Unexpected WaveSpeed output: ${out.slice(0, 120)}`);
    return { buffer: Buffer.from(out, 'base64'), mime: 'audio/wav' };
  }
  const res = await fetchRetry(out, undefined, 4, 'download audio');
  if (!res.ok) throw new Error(`Failed to download the generated audio (${res.status})`);
  let mime = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
  if (!mime.startsWith('audio/')) {
    const ext = path.extname(new URL(out).pathname).slice(1);
    mime = ext ? extToMime(ext) : 'audio/wav';
    if (!mime.startsWith('audio/')) mime = 'audio/wav';
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), mime };
}

async function saveAudio(clip: { buffer: Buffer; mime: string }, prefix: string): Promise<string> {
  return (await saveBuffer(clip.buffer, clip.mime, prefix)).url;
}

/** Recent "Create voice" results, so "Another take" reuses the voice (description + phrase) without another LLM call. */
interface Design {
  id: string;
  request: string;
  spec: VoiceSpec;
  takes: number;
}
const designs = new Map<string, Design>();
function rememberDesign(d: Design) {
  designs.delete(d.id);
  designs.set(d.id, d);
  while (designs.size > 200) designs.delete(designs.keys().next().value as string);
}

function qwenDesign(description: string, phrase: string, lang: string) {
  return wavespeedRunRaw(MODELS.design(), { text: phrase, voice_description: description, language: QWEN_LANGS[lang] ?? 'auto' }, 180000).then((o) => downloadAudio(o));
}

type Phrase = { start: number; end: number; text: string };

/** Whisper outputs (URL to JSON/text, JSON string or object) → plain transcript + timed phrases when requested. */
async function whisperText(outputs: unknown[]): Promise<{ text: string; language?: string; segments: Phrase[] }> {
  const parts: string[] = [];
  const segments: Phrase[] = [];
  let language: string | undefined;
  for (const out of outputs) {
    let payload: unknown = out;
    if (typeof out === 'string') {
      let raw = out;
      if (/^https?:\/\//.test(out)) {
        const res = await fetchRetry(out, undefined, 3, 'download transcript');
        if (!res.ok) throw new Error(`Failed to download the transcript (${res.status})`);
        raw = await res.text();
      }
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { text: raw };
      }
    }
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const timed = parseWhisperSegments(payload);
    segments.push(...timed.map((s) => ({ start: s.start, end: s.end, text: s.text })));
    if (typeof p.text === 'string') parts.push(p.text);
    else if (timed.length) parts.push(timed.map((s) => s.text).join(' '));
    if (typeof p.language === 'string') language = p.language;
  }
  return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), language, segments };
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Audio from any file ffmpeg understands → 24 kHz mono WAV (for videos the browser cannot decode). */
async function extractWav(file: string): Promise<Buffer> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-'));
  const out = path.join(tmp, 'out.wav');
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out]);
      const timer = setTimeout(() => {
        p.kill('SIGKILL');
        reject(new Error('ffmpeg took too long'));
      }, 120000);
      let err = '';
      p.stderr.on('data', (d) => (err += d.toString()));
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`));
      });
    });
    return await fs.readFile(out);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------- Uploads ----------

/** What may be uploaded: audio / video containers only, stored under their proper extension. */
const UPLOAD_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mp4', 'audio/x-m4a',
  'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/x-flac',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo', 'video/3gpp',
  // Only readable through ffmpeg (POST /extract), which is why they are accepted at all.
  'video/x-ms-wmv', 'video/x-ms-asf', 'audio/x-ms-wma', 'video/x-flv', 'video/mp2t', 'video/mpeg',
  'audio/aiff', 'audio/x-aiff', 'audio/amr', 'audio/x-caf',
]);

/** Checks the first bytes, so a page or script cannot be stored under an audio type. */
function looksLikeMedia(b: Buffer): boolean {
  if (b.length < 12) return false;
  const s = (a: number, e: number) => b.toString('latin1', a, e);
  return (
    (s(0, 4) === 'RIFF' && (s(8, 12) === 'WAVE' || s(8, 12) === 'AVI ')) ||
    s(0, 3) === 'ID3' ||
    (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) ||
    ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(s(4, 8)) ||
    (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ||
    s(0, 4) === 'OggS' ||
    s(0, 4) === 'fLaC' ||
    (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) ||
    s(0, 3) === 'FLV' ||
    (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) ||
    (b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3)) ||
    (s(0, 4) === 'FORM' && (s(8, 12) === 'AIFF' || s(8, 12) === 'AIFC')) ||
    s(0, 5) === '#!AMR' ||
    s(0, 4) === 'caff'
  );
}

// ---------- Router ----------

export function createVoiceRouter(): Router {
  const r = Router();
  /** Built-in voices whose clip is being made right now → job id (two clicks never pay twice). */
  const making = new Map<string, string>();

  // Bodies are JSON everywhere except the raw upload: a plain cross-site form post never reaches a handler.
  r.use((req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PATCH') && req.path !== '/upload' && !req.is('application/json')) {
      return void res.status(415).json({ error: 'Send the request as JSON' });
    }
    next();
  });

  // Anchor clips of the built-in voices: top-level audio files only (not the index, not archive/).
  r.use('/preset-audio', (req, res, next) => {
    let file: string;
    try {
      file = decodeURIComponent(req.path);
    } catch {
      return void res.status(400).end();
    }
    if (!/^\/[^/\\:%]+$/.test(file) || !AUDIO_EXT.test(file)) return void res.status(404).end();
    next();
  });
  r.use('/preset-audio', express.static(presetsDir(isMock()), { maxAge: '30d', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));

  r.get('/health', async (_req, res) => {
    try {
      const presets = await listPresets(isMock());
      res.json({
        provider: voiceProvider(),
        ffmpeg: await ffmpegAvailable(),
        models: { clone: MODELS.clone(), design: MODELS.design(), isolate: MODELS.isolate(), whisper: MODELS.whisper(), llm: MODELS.llm() },
        prices: PRICES,
        presets: { total: presets.length, ready: presets.filter((p) => p.sample).length },
        presetsEditable: presetsEditable(),
        budget: { daily: Number.isFinite(dailyBudget()) ? dailyBudget() : null, spentToday: Math.round(spentToday() * 10000) / 10000 },
      });
    } catch (e) {
      fail(res, e);
    }
  });

  // ----- Library -----

  r.get('/voices', async (_req, res) => {
    try {
      res.json({ presets: await listPresets(isMock()), mine: await listCustom(isMock()) });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/voices', async (req, res) => {
    try {
      res.json(await createCustom(isMock(), req.body ?? {}));
    } catch (e) {
      fail(res, e);
    }
  });

  r.patch('/voices/:id', async (req, res) => {
    try {
      res.json(await updateCustom(isMock(), req.params.id, req.body ?? {}));
    } catch (e) {
      fail(res, e);
    }
  });

  r.delete('/voices/:id', async (req, res) => {
    try {
      await deleteCustom(isMock(), req.params.id);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Makes the anchor clips of built-in voices (Qwen3 Voice Design, 3 at a time) → job. */
  r.post('/presets/prepare', async (req, res) => {
    try {
      if (!presetsEditable()) throw new HttpError(403, 'Built-in voices are read-only here');
      const mock = isMock();
      const rawIds: unknown = req.body?.ids;
      if (rawIds !== undefined && (!Array.isArray(rawIds) || !rawIds.length || rawIds.some((id) => typeof id !== 'string' || !findPreset(id)))) {
        throw new HttpError(400, '"ids" must be a list of built-in voice ids');
      }
      const ids = rawIds as string[] | undefined;
      const force = req.body?.force === true;
      if (force && !ids) throw new HttpError(400, 'Regenerating needs the list of voice "ids"');
      if (!ids && req.body?.all !== true) throw new HttpError(400, 'Say which voices: "ids", or "all": true for every missing one');
      const current = await listPresets(mock);
      const wanted = PRESETS.filter((p) => (!ids || ids.includes(p.id)) && (force || !current.find((v) => v.id === p.id)?.sample));
      const targets = wanted.filter((p) => !making.has(p.id));
      if (!targets.length) {
        // Already being made by an earlier click: follow that job instead of paying twice.
        res.json({ jobId: wanted.map((p) => making.get(p.id)).find(Boolean) ?? null, count: 0, cost: 0 });
        return;
      }
      const cost = mock ? 0 : targets.reduce((sum, p) => sum + qwenPrice(p.sampleText.length), 0);
      const release = reserve(req, cost);
      const job = createJob('voice-presets', async (update) => {
        let finished = 0;
        const failed: string[] = [];
        update(`Ready 0 of ${targets.length}`);
        await pool(targets, 3, async (p) => {
          try {
            const clip = mock
              ? { buffer: babbleWav(p.sampleText, { f0: mockPitch(p.gender, p.age, p.id), seed: p.id }), mime: 'audio/wav' }
              : await qwenDesign(p.prompt, p.sampleText, 'en');
            await savePresetAnchor(mock, p.id, clip.buffer, mimeToExt(clip.mime), p.sampleText, p.prompt);
          } catch (e) {
            failed.push(`${p.name}: ${(e as Error).message}`);
            console.error(`[voice] preset ${p.id} failed: ${(e as Error).message}`);
          } finally {
            making.delete(p.id);
          }
          finished += 1;
          update(`Ready ${finished} of ${targets.length}`);
        });
        if (failed.length === targets.length) release();
        return { ready: targets.length - failed.length, total: targets.length, failed };
      });
      for (const p of targets) making.set(p.id, job.id);
      res.json({ jobId: job.id, count: targets.length, cost });
    } catch (e) {
      fail(res, e);
    }
  });

  r.get('/job/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found (was the server restarted?)' });
      return;
    }
    res.json(publicJob(job));
  });

  // ----- Files -----

  /** Raw binary upload (the file itself as the request body, its type in Content-Type) → /media URL. */
  r.post('/upload', express.raw({ type: () => true, limit: '600mb' }), async (req, res) => {
    try {
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'The file is empty');
      const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!UPLOAD_TYPES.has(mime)) throw new HttpError(415, 'Please upload an audio or video file (MP3, WAV, M4A, OGG, FLAC, MP4, WebM, MOV)');
      if (!looksLikeMedia(body)) throw new HttpError(415, 'This file does not look like audio or video');
      const prefix = String(req.query.prefix || 'voice').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'voice';
      const saved = await saveBuffer(body, mime, prefix);
      res.json({ url: saved.url, mime: saved.mime, bytes: body.length });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Audio track of an uploaded file as 24 kHz mono WAV, via ffmpeg (when the browser cannot decode the file). */
  r.post('/extract', async (req, res) => {
    try {
      if (!(await ffmpegAvailable())) {
        res.status(501).json({ error: 'The browser could not read audio from this file and ffmpeg is not installed on the server. Save it as MP4 or MP3 and try again.' });
        return;
      }
      const url = await mediaAudio(req.body?.url, 'url', SOURCE_EXT);
      const wav = await extractWav(mediaPath(url));
      res.json({ url: (await saveBuffer(wav, 'audio/wav', 'extract')).url });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Removes music and background noise: Audio Vocal Isolator, first output = vocals. */
  r.post('/isolate', async (req, res) => {
    let release = () => undefined as void;
    let paid = false;
    try {
      const audio = await mediaAudio(req.body?.audio, 'audio');
      const seconds = await clipSeconds(audio);
      if (isMock()) {
        await new Promise((r2) => setTimeout(r2, 600));
        res.json({ url: audio, cost: 0, mock: true });
        return;
      }
      const cost = isolatePrice(seconds);
      release = reserve(req, cost);
      const outputs = await wavespeedRunRaw(MODELS.isolate(), { audio: await remoteFileUrl(mediaPath(audio)) }, 300000);
      paid = true;
      res.json({ url: await saveAudio(await downloadAudio(outputs, 0), 'vocals'), cost });
    } catch (e) {
      if (paid) return failAfterPaid(res, e);
      release();
      fail(res, e);
    }
  });

  /**
   * What is said in a clip (Whisper large-v3): becomes the clip's reference_text. With `timestamps` it also returns
   * the timed phrases, so the client can drop everything around the recognised speech (music, noise, silence).
   */
  r.post('/transcribe', async (req, res) => {
    let release = () => undefined as void;
    let paid = false;
    try {
      const audio = await mediaAudio(req.body?.audio, 'audio');
      const seconds = await clipSeconds(audio);
      const timestamps = !!req.body?.timestamps;
      if (isMock()) {
        await new Promise((r2) => setTimeout(r2, 500));
        // A fake phrase over most of the clip, so the trimming path runs in mock mode too.
        const segments = timestamps ? [{ start: Math.min(0.3, seconds / 4), end: Math.max(0.5, seconds - 0.3), text: 'This is a mock transcript.' }] : [];
        res.json({ text: 'This is a mock transcript.', segments, cost: 0, mock: true });
        return;
      }
      const cost = whisperPrice(seconds, timestamps);
      release = reserve(req, cost);
      const outputs = await wavespeedRunRaw(
        MODELS.whisper(),
        { audio: await remoteFileUrl(mediaPath(audio)), language: 'auto', task: 'transcribe', enable_timestamps: timestamps },
        180000,
      );
      paid = true;
      res.json({ ...(await whisperText(outputs)), cost });
    } catch (e) {
      if (paid) return failAfterPaid(res, e);
      release();
      fail(res, e);
    }
  });

  // ----- Generation -----

  /** Text in a voice: OmniVoice voice-clone with the voice's anchor clip (library voice or an ad-hoc sample). */
  r.post('/speak', async (req, res) => {
    let release = () => undefined as void;
    let paid = false;
    try {
      const mock = isMock();
      const b = req.body ?? {};
      const phrase = speakable(text(b.text, 'text').trim(), 'text');
      if (phrase.length > MAX_SPEAK_CHARS) throw new HttpError(400, `Text is too long: up to ${MAX_SPEAK_CHARS} characters per request`);
      const speed = clamp(Number(b.speed) || 1, 0.5, 2);
      const voiceId = text(b.voiceId, 'voiceId', false);

      let file: string;
      let sampleText: string;
      let pitch: number;
      if (voiceId) {
        const ref = await voiceReference(mock, voiceId);
        if (!ref) {
          res.status(409).json({ error: 'This voice has no sample yet', needsPrepare: true });
          return;
        }
        file = ref.file;
        sampleText = ref.sampleText;
        pitch = mockPitch(ref.gender, ref.age, voiceId);
      } else {
        const sample = await mediaAudio(b.sample, 'sample');
        file = mediaPath(sample);
        sampleText = text(b.sampleText, 'sampleText', false).trim();
        pitch = 100 + (hashString(sample) % 160);
      }

      if (mock) {
        const url = await saveAudio({ buffer: babbleWav(phrase, { f0: pitch, speed, seed: voiceId || file }), mime: 'audio/wav' }, 'speech');
        res.json({ url, cost: 0, chars: phrase.length, mock: true });
        return;
      }

      const cost = omniPrice(phrase.length);
      release = reserve(req, cost);
      const body: Record<string, unknown> = { text: phrase, audio: await remoteFileUrl(file), speed };
      if (sampleText) body.reference_text = sampleText;
      const outputs = await wavespeedRunRaw(MODELS.clone(), body, 240000);
      paid = true;
      res.json({ url: await saveAudio(await downloadAudio(outputs), 'speech'), cost, chars: phrase.length });
    } catch (e) {
      if (paid) return failAfterPaid(res, e);
      release();
      fail(res, e);
    }
  });

  /**
   * New voice from a description: spec (LLM or rules) → one take from Qwen3 Voice Design. With "again" (the id of an
   * earlier result for the same description) it makes one more take of that voice: same description and phrase, no
   * second LLM call, so the takes can be compared.
   */
  r.post('/design', async (req, res) => {
    let release = () => undefined as void;
    let cost = 0;
    let paid = false;
    try {
      const mock = isMock();
      const b = req.body ?? {};
      const request = text(b.description, 'description', false).trim().slice(0, 1200);
      if (!request) throw new HttpError(400, 'Describe the voice first');
      const earlier = typeof b.again === 'string' ? designs.get(b.again) : undefined;
      const reuse = earlier && earlier.request === request ? earlier : undefined;

      // Worst case up front (LLM + a phrase of up to 200 characters); the actual price is reported back.
      release = reserve(req, mock ? 0 : (reuse ? 0 : PRICES.llmPerRun) + qwenPrice(reuse?.spec.sample.length ?? 200));

      let spec: VoiceSpec = reuse?.spec ?? ruleSpec(request);
      if (!reuse && !mock) {
        try {
          spec = await llmSpec(request);
          cost += PRICES.llmPerRun;
        } catch (e) {
          console.warn(`[voice] LLM spec failed, using rules: ${(e as Error).message}`);
        }
      }
      const take = (reuse?.takes ?? 0) + 1;
      let clip: { buffer: Buffer; mime: string };
      if (mock) {
        const seed = `${request}|${take}`;
        clip = { buffer: babbleWav(spec.sample, { f0: mockPitch(spec.gender, spec.age, seed), seed }), mime: 'audio/wav' };
      } else {
        const outputs = await wavespeedRunRaw(MODELS.design(), { text: spec.sample, voice_description: spec.description, language: QWEN_LANGS[spec.language] ?? 'English' }, 180000);
        paid = true;
        cost += qwenPrice(spec.sample.length);
        clip = await downloadAudio(outputs);
      }
      const url = await saveAudio(clip, 'design');
      const id = reuse?.id ?? `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      rememberDesign({ id, request, spec, takes: take });
      // Keep only what was really spent reserved.
      release();
      reserve(null, cost);
      res.json({
        id,
        spec,
        sampleText: spec.sample,
        language: QWEN_LANGS[spec.language] ?? 'English',
        take: { id: `${id}_${take}`, url },
        cost: Math.round(cost * 10000) / 10000,
        mock: mock || undefined,
      });
    } catch (e) {
      release();
      if (cost) reserve(null, cost);
      if (paid) return failAfterPaid(res, e);
      fail(res, e);
    }
  });

  return r;
}
