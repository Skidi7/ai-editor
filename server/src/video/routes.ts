import { Router, type Request, type Response } from 'express';
import { hasWaveSpeedKey, wavespeedRunRaw, wavespeedSubmit, wavespeedUpload, wavespeedWait } from '../providers/wavespeed.js';
import { fetchRetry } from '../util.js';
import { alignWords, hasWordLevel, normalizeSegments, parseWhisperSegments, parseWhisperWords, type HeardWord, type Segment } from './align.js';
import { createJob, getJob, publicJob } from './jobs.js';
import { mockImage } from './mock.js';
import { buildInsertPrompt, buildLookPrompt, buildSwapPrompt, buildTakePrompt, type EditRhythm, type Gesture, type Performance } from './prompts.js';
import { inputAsDataUrl, isMediaUrl, readInput, saveDataUrl, storeRemote } from './storage.js';
import { ffmpegAvailable, transcodeToMp4 } from './transcode.js';

/**
 * Video Studio API. Mirrors the Hypit pipeline with WaveSpeed models:
 *   presenter still  → Seedream 5.0 Pro edit (reference photo + outfit/pose/setting)   POST /still
 *   insert image     → Seedream 5.0 Pro text-to-image (or edit with a reference)        POST /image
 *   speaking take    → Seedance 2.5 image-to-video (async job)                          POST /take, GET /job/:id
 *   word timings     → Whisper (large-v3) with word timestamps + script alignment        POST /align
 *   export           → optional ffmpeg WebM→MP4                                          POST /transcode
 */

export type VideoProvider = 'wavespeed' | 'mock';

export function videoProvider(): VideoProvider {
  const p = (process.env.VIDEO_PROVIDER || '').toLowerCase();
  if (p === 'mock') return 'mock';
  if (p === 'wavespeed') return 'wavespeed';
  return hasWaveSpeedKey() ? 'wavespeed' : 'mock';
}

const MODELS = {
  still: () => process.env.WAVESPEED_SEEDREAM_MODEL || 'bytedance/seedream-v5.0-pro/edit',
  image: () => process.env.WAVESPEED_SEEDREAM_T2I_MODEL || 'bytedance/seedream-v5.0-pro',
  take: () => process.env.WAVESPEED_SEEDANCE_I2V_MODEL || 'bytedance/seedance-2.5/image-to-video',
  takeReference: () => process.env.WAVESPEED_SEEDANCE_T2V_MODEL || 'bytedance/seedance-2.5/text-to-video',
  edit: () => process.env.WAVESPEED_SEEDANCE_EDIT_MODEL || 'bytedance/seedance-2.5/video-edit',
  whisper: () => process.env.WAVESPEED_WHISPER_MODEL || 'wavespeed-ai/openai-whisper-with-video',
};

const STILL_RESOLUTION = () => process.env.VIDEO_STILL_RESOLUTION || '2k';
const TAKE_TIMEOUT = 25 * 60 * 1000;

type Resolution = '480p' | '720p' | '1080p';
const TAKE_PRICE_PER_SEC: Record<Resolution, number> = { '480p': 0.18, '720p': 0.36, '1080p': 0.9 };
/** video-edit bills input + output seconds together. */
const EDIT_PRICE_PER_SEC: Record<Resolution, number> = { '480p': 0.11, '720p': 0.22, '1080p': 0.55 };

const IMAGE_ASPECTS = new Set(['1:1', '1:2', '2:1', '1:3', '3:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9']);
const VIDEO_ASPECTS = new Set(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']);

function fail(res: Response, e: unknown, status = 500) {
  const msg = (e as Error).message || String(e);
  console.error('[video]', msg);
  res.status(status).json({ error: msg });
}

function str(v: unknown, field: string, required = true): string {
  if (typeof v !== 'string' || (required && !v.trim())) {
    if (!required && (v === undefined || v === null)) return '';
    throw new Error(`"${field}" is required`);
  }
  return v;
}

function imageAspect(v: unknown, fallback = '9:16'): string {
  return typeof v === 'string' && IMAGE_ASPECTS.has(v) ? v : fallback;
}

function isRemoteUrl(s: string) {
  return /^https?:\/\//.test(s);
}

/** Any of our inputs (data URL, /media URL, http URL) as a public URL WaveSpeed can download. */
async function asPublicUrl(input: string, filename: string): Promise<string> {
  if (isRemoteUrl(input)) return input;
  const { mime, buffer } = await readInput(input);
  return wavespeedUpload(buffer, filename, mime);
}

async function firstOutputUrl(outputs: unknown[]): Promise<string> {
  const out = outputs[0];
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    const u = o.url ?? o.video ?? o.image ?? o.output;
    if (typeof u === 'string') return u;
  }
  throw new Error(`Unexpected WaveSpeed output: ${JSON.stringify(out).slice(0, 200)}`);
}

async function storeImageOutput(outputs: unknown[], prefix: string): Promise<string> {
  const out = await firstOutputUrl(outputs);
  if (out.startsWith('http')) return (await storeRemote(out, prefix, 'image/png')).url;
  if (out.startsWith('data:')) return (await saveDataUrl(out, prefix)).url;
  return (await saveDataUrl(`data:image/png;base64,${out}`, prefix)).url;
}

/**
 * Connectivity probe, cached for 30 s. Reports "down" only after two consecutive failed probes, because the
 * API path is sometimes slow or flaky for a moment and a single miss must not alarm the user.
 */
let reachCache: { at: number; ok: boolean } | null = null;
let reachFailures = 0;
async function wavespeedReachable(): Promise<boolean> {
  if (reachCache && Date.now() - reachCache.at < 30000) return reachCache.ok;
  const base = (process.env.WAVESPEED_BASE_URL || 'https://api.wavespeed.ai/api/v3').replace(/\/$/, '');
  let ok = false;
  try {
    // Any HTTP answer (even 401/404) proves the network path works; only a connect error/timeout counts as down.
    await fetch(`${base}/predictions/health-probe/result`, { method: 'GET', signal: AbortSignal.timeout(15000) });
    ok = true;
  } catch {
    ok = false;
  }
  reachFailures = ok ? 0 : reachFailures + 1;
  const reported = ok || reachFailures < 2;
  reachCache = { at: Date.now(), ok: reported };
  return reported;
}

/**
 * Cheap MP4 sanity check: walks the top-level boxes and compares the declared sizes with the real file size.
 * A file whose `mdat` claims more bytes than exist is a cut-off download: players show the first part, but
 * audio decoders and Whisper stop early, which looks like "the analysis is broken".
 */
async function mp4Integrity(url: string): Promise<{ bytes: number; truncated: boolean; presentFraction: number } | null> {
  try {
    const { buffer } = await readInput(url);
    const bytes = buffer.byteLength;
    if (bytes < 16) return null;
    const type = buffer.subarray(4, 8).toString('latin1');
    if (type !== 'ftyp') return null;
    let i = 0;
    let declared = 0;
    let mdatStart = -1;
    let mdatSize = 0;
    while (i + 8 <= bytes) {
      let size = buffer.readUInt32BE(i);
      const box = buffer.subarray(i + 4, i + 8).toString('latin1');
      if (size === 1 && i + 16 <= bytes) size = Number(buffer.readBigUInt64BE(i + 8));
      if (size === 0) size = bytes - i;
      if (size < 8) break;
      if (box === 'mdat' && mdatStart < 0) {
        mdatStart = i;
        mdatSize = size;
      }
      declared = i + size;
      i += size;
    }
    const truncated = declared > bytes + 16;
    let presentFraction = 1;
    if (truncated && mdatStart >= 0 && mdatSize > 0) presentFraction = Math.max(0, Math.min(1, (bytes - mdatStart) / mdatSize));
    else if (truncated) presentFraction = bytes / declared;
    return { bytes, truncated, presentFraction: Math.round(presentFraction * 100) / 100 };
  } catch {
    return null;
  }
}

export function createVideoRouter(): Router {
  const r = Router();

  r.get('/health', async (_req, res) => {
    const provider = videoProvider();
    res.json({
      provider,
      reachable: provider === 'wavespeed' ? await wavespeedReachable() : true,
      ffmpeg: await ffmpegAvailable(),
      whisper: provider === 'wavespeed',
      models: {
        still: MODELS.still(),
        image: MODELS.image(),
        take: MODELS.take(),
        takeReference: MODELS.takeReference(),
        edit: MODELS.edit(),
        whisper: MODELS.whisper(),
      },
      prices: { takePerSecond: TAKE_PRICE_PER_SEC, editPerSecond: EDIT_PRICE_PER_SEC, image2k: 0.09, whisperPerSecond: 0.002 },
    });
  });

  /** Stores an uploaded file (data URL) and returns its /media URL, plus a warning when an MP4 is incomplete. */
  r.post('/upload', async (req, res) => {
    try {
      const data = str(req.body?.data, 'data');
      if (!data.startsWith('data:')) throw new Error('"data" must be a data URL');
      const prefix = typeof req.body?.prefix === 'string' ? req.body.prefix : 'upload';
      const saved = await saveDataUrl(data, prefix);
      const check = prefix === 'source' || prefix === 'take' ? await mp4Integrity(saved.url) : null;
      res.json({ url: saved.url, mime: saved.mime, bytes: check?.bytes, truncated: check?.truncated, presentFraction: check?.presentFraction });
    } catch (e) {
      fail(res, e, 400);
    }
  });

  /** Derived presenter still: reference photo + outfit / pose / setting → Seedream 5.0 Pro edit, 2K. */
  r.post('/still', async (req, res) => {
    try {
      const reference = str(req.body?.reference, 'reference');
      const aspect = imageAspect(req.body?.aspect);
      const prompt = buildLookPrompt({
        outfit: str(req.body?.outfit, 'outfit', false),
        pose: str(req.body?.pose, 'pose', false),
        setting: str(req.body?.setting, 'setting', false),
        extra: str(req.body?.extra, 'extra', false),
        aspect,
      });
      if (videoProvider() === 'mock') {
        await new Promise((r) => setTimeout(r, 900));
        // Mock: reuse the reference photo itself so the flow can be exercised without credits.
        const url = isMediaUrl(reference) ? reference : (await saveDataUrl(await inputAsDataUrl(reference), 'look')).url;
        res.json({ url, prompt, mock: true });
        return;
      }
      const outputs = await wavespeedRunRaw(
        MODELS.still(),
        {
          prompt,
          images: [await inputAsDataUrl(reference)],
          aspect_ratio: aspect,
          resolution: STILL_RESOLUTION(),
          output_format: 'png',
          prompt_optimization_mode: 'standard',
          enable_safety_checker: false,
        },
        240000,
      );
      res.json({ url: await storeImageOutput(outputs, 'look'), prompt });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Insert (B-roll) image: text → Seedream 5.0 Pro, or reference + text → Seedream edit. */
  r.post('/image', async (req, res) => {
    try {
      const userPrompt = str(req.body?.prompt, 'prompt');
      const aspect = imageAspect(req.body?.aspect, '4:3');
      const reference = str(req.body?.reference, 'reference', false);
      const prompt = buildInsertPrompt(userPrompt);
      if (videoProvider() === 'mock') {
        await new Promise((r) => setTimeout(r, 700));
        res.json({ url: await mockImage(userPrompt, aspect, 'insert'), prompt, mock: true });
        return;
      }
      const common = {
        prompt,
        aspect_ratio: aspect,
        resolution: STILL_RESOLUTION(),
        output_format: 'png',
        prompt_optimization_mode: 'standard',
        enable_safety_checker: false,
      };
      const outputs = reference
        ? await wavespeedRunRaw(MODELS.still(), { ...common, images: [await inputAsDataUrl(reference)] }, 240000)
        : await wavespeedRunRaw(MODELS.image(), common, 240000);
      res.json({ url: await storeImageOutput(outputs, 'insert'), prompt });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Speaking take → async job. */
  r.post('/take', async (req, res) => {
    try {
      const b = req.body ?? {};
      const image = str(b.image, 'image');
      const p = b.prompt ?? {};
      const dialogue = str(p.dialogue, 'prompt.dialogue');
      const duration = Math.min(30, Math.max(4, Math.round(Number(b.duration) || 5)));
      const resolution: Resolution = (['480p', '720p', '1080p'] as Resolution[]).includes(b.resolution) ? b.resolution : '720p';
      const mode: 'image' | 'reference' = b.mode === 'reference' ? 'reference' : 'image';
      const aspect = typeof b.aspect === 'string' && VIDEO_ASPECTS.has(b.aspect) ? b.aspect : '9:16';
      const voiceSample = str(b.voiceSample, 'voiceSample', false);
      const prompt = buildTakePrompt({
        dialogue,
        action: str(p.action, 'prompt.action', false),
        voice: str(p.voice, 'prompt.voice', false),
        performance: p.performance as Performance | undefined,
        gesture: p.gesture as Gesture | undefined,
        editRhythm: p.editRhythm as EditRhythm | undefined,
        mode,
        hasVoiceSample: !!voiceSample,
        language: str(p.language, 'prompt.language', false) || undefined,
      });
      const cost = Math.round(TAKE_PRICE_PER_SEC[resolution] * duration * 100) / 100;

      if (videoProvider() === 'mock') {
        const job = createJob('take', async (update) => {
          update('Mock: pretending to generate');
          await new Promise((r) => setTimeout(r, 1500));
          return { video: null, duration, mock: true };
        });
        res.json({ jobId: job.id, prompt, cost, mock: true });
        return;
      }

      const job = createJob('take', async (update) => {
        update('Uploading start frame');
        const imageUrl = await asPublicUrl(image, 'start-frame.png');
        let taskId: string;
        if (mode === 'reference') {
          const body: Record<string, unknown> = {
            prompt,
            aspect_ratio: aspect,
            duration,
            resolution,
            generate_audio: true,
            reference_images: [imageUrl],
          };
          if (voiceSample) {
            update('Uploading voice sample');
            body.reference_audios = [await asPublicUrl(voiceSample, 'voice-sample.mp3')];
          }
          update('Submitting to Seedance 2.5 (reference mode)');
          taskId = await wavespeedSubmit(MODELS.takeReference(), body);
        } else {
          update('Submitting to Seedance 2.5');
          taskId = await wavespeedSubmit(MODELS.take(), { prompt, image: imageUrl, duration, resolution, generate_audio: true });
        }
        const outputs = await wavespeedWait(taskId, TAKE_TIMEOUT, (status, ms) => update(`Seedance: ${status} · ${Math.round(ms / 1000)}s`));
        update('Downloading the take');
        const remoteUrl = await firstOutputUrl(outputs);
        const stored = await storeRemote(remoteUrl, 'take', 'video/mp4');
        return { video: stored.url, remoteUrl, duration, bytes: stored.bytes };
      });
      res.json({ jobId: job.id, prompt, cost });
    } catch (e) {
      fail(res, e, 400);
    }
  });

  /** Swap the person inside a piece of the source video (Seedance 2.5 video-edit) → async job. */
  r.post('/edit', async (req, res) => {
    try {
      const b = req.body ?? {};
      const video = str(b.video, 'video');
      const reference = str(b.reference, 'reference');
      const resolution: Resolution = (['480p', '720p', '1080p'] as Resolution[]).includes(b.resolution) ? b.resolution : '720p';
      const seconds = Math.max(4, Math.min(30, Number(b.duration) || 5));
      const prompt = buildSwapPrompt({ notes: str(b.notes, 'notes', false), keepOutfit: !!b.keepOutfit });
      const cost = Math.round(EDIT_PRICE_PER_SEC[resolution] * seconds * 2 * 100) / 100;

      if (videoProvider() === 'mock') {
        const job = createJob('edit', async (update) => {
          update('Mock: pretending to edit');
          await new Promise((r) => setTimeout(r, 1500));
          return { video: null, duration: seconds, mock: true };
        });
        res.json({ jobId: job.id, prompt, cost, mock: true });
        return;
      }

      const job = createJob('edit', async (update) => {
        update('Uploading the clip');
        const videoUrl = await asPublicUrl(video, 'clip.webm');
        update('Uploading the reference photo');
        const refUrl = await asPublicUrl(reference, 'reference.png');
        // The provider's content filter rejects some results with real faces at random; a retry usually passes.
        const ATTEMPTS = 3;
        let outputs: unknown[] = [];
        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
          update(attempt === 1 ? 'Submitting to Seedance 2.5 video-edit' : `Rejected by the content filter, retrying (${attempt}/${ATTEMPTS})`);
          const taskId = await wavespeedSubmit(MODELS.edit(), {
            prompt,
            video: videoUrl,
            reference_images: [refUrl],
            resolution,
            // Keep the original speech: the new person lip-syncs to it.
            generate_audio: false,
          });
          try {
            outputs = await wavespeedWait(taskId, TAKE_TIMEOUT, (status, ms) => update(`Seedance edit${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${status} · ${Math.round(ms / 1000)}s`));
            break;
          } catch (e) {
            const msg = (e as Error).message;
            if (attempt < ATTEMPTS && /rejected|content|safety|moderation/i.test(msg)) {
              console.warn(`[video] edit attempt ${attempt} rejected: ${msg}`);
              continue;
            }
            throw e;
          }
        }
        update('Downloading the result');
        const remoteUrl = await firstOutputUrl(outputs);
        const stored = await storeRemote(remoteUrl, 'edit', 'video/mp4');
        return { video: stored.url, remoteUrl, duration: seconds, bytes: stored.bytes };
      });
      res.json({ jobId: job.id, prompt, cost });
    } catch (e) {
      fail(res, e, 400);
    }
  });

  r.get('/job/:id', (req: Request, res: Response) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(publicJob(job));
  });

  /** Reads Whisper outputs (URL to JSON, inline JSON string, or object) into plain payloads. */
  async function whisperPayloads(outputs: unknown[]): Promise<unknown[]> {
    const payloads: unknown[] = [];
    for (const out of outputs) {
      let payload: unknown = out;
      if (typeof out === 'string') {
        if (out.startsWith('http')) {
          const r2 = await fetchRetry(out, undefined, 3, 'download transcript');
          const text = await r2.text();
          try {
            payload = JSON.parse(text);
          } catch {
            payload = { text };
          }
        } else {
          try {
            payload = JSON.parse(out);
          } catch {
            payload = { text: out };
          }
        }
      }
      payloads.push(payload);
    }
    return payloads;
  }

  /** Source video → speech segments (scenes). */
  r.post('/analyze', async (req, res) => {
    try {
      if (videoProvider() === 'mock') {
        res.status(501).json({ error: 'Whisper is not configured (mock mode)', fallback: 'chunks' });
        return;
      }
      const b = req.body ?? {};
      const video = str(b.video, 'video');
      const language = str(b.language, 'language', false) || 'auto';
      const duration = Number(b.duration) || undefined;
      const source = await asPublicUrl(video, 'source.mp4');
      const model = MODELS.whisper();
      const field = /video/i.test(model) ? 'video' : 'audio';
      const outputs = await wavespeedRunRaw(model, { [field]: source, language, task: 'transcribe', enable_timestamps: true }, 600000);
      let segments: Segment[] = [];
      let wordLevel = false;
      for (const payload of await whisperPayloads(outputs)) {
        segments = segments.concat(parseWhisperSegments(payload));
        wordLevel = wordLevel || hasWordLevel(payload);
      }
      if (!segments.length) {
        res.status(502).json({ error: 'Whisper returned no timed segments', fallback: 'chunks' });
        return;
      }
      res.json({ segments: normalizeSegments(segments, duration), granularity: wordLevel ? 'word' : 'segment' });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Word timings for a take: Whisper (word timestamps) + alignment to the script words. */
  r.post('/align', async (req, res) => {
    try {
      if (videoProvider() === 'mock') {
        res.status(501).json({ error: 'Whisper is not configured (mock mode)', fallback: 'estimate' });
        return;
      }
      const b = req.body ?? {};
      const words = Array.isArray(b.words) ? (b.words as unknown[]).map((w) => String(w)) : [];
      if (!words.length) throw new Error('"words" is empty');
      const video = str(b.video, 'video');
      const remoteUrl = str(b.remoteUrl, 'remoteUrl', false);
      const duration = Math.max(1, Number(b.duration) || 10);
      const language = str(b.language, 'language', false) || 'auto';

      let source = remoteUrl && isRemoteUrl(remoteUrl) ? remoteUrl : '';
      if (source) {
        // Remote result URLs expire; fall back to uploading our own copy if it is gone.
        const head = await fetchRetry(source, { method: 'HEAD' }, 2, 'check remote take').catch(() => null);
        if (!head || !head.ok) source = '';
      }
      if (!source) source = await asPublicUrl(video, 'take.mp4');

      const model = MODELS.whisper();
      const field = /video/i.test(model) ? 'video' : 'audio';
      const outputs = await wavespeedRunRaw(model, { [field]: source, language, task: 'transcribe', enable_timestamps: true }, 300000);

      let heard: HeardWord[] = [];
      let wordLevel = false;
      for (const payload of await whisperPayloads(outputs)) {
        heard = heard.concat(parseWhisperWords(payload));
        wordLevel = wordLevel || hasWordLevel(payload);
      }
      if (!heard.length) {
        res.status(502).json({ error: 'Whisper returned no word timestamps', fallback: 'estimate' });
        return;
      }
      const aligned = alignWords(words, heard, duration);
      res.json({ words: aligned.words, matched: aligned.matched, heard: heard.length, source: 'whisper', granularity: wordLevel ? 'word' : 'segment' });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Browser export (WebM) → MP4 when ffmpeg is installed. */
  r.post('/transcode', async (req, res) => {
    try {
      if (!(await ffmpegAvailable())) {
        res.status(501).json({ error: 'ffmpeg is not installed on the server', fallback: 'webm' });
        return;
      }
      const data = str(req.body?.data, 'data');
      const url = await transcodeToMp4(data);
      res.json({ url });
    } catch (e) {
      fail(res, e);
    }
  });

  return r;
}
