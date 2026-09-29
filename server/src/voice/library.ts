import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extToMime, isMediaUrl, mediaDir, mediaPath } from '../video/storage.js';
import { HttpError } from './errors.js';
import { PRESETS, findPreset, type AgeGroup, type Gender, type VoicePreset } from './presets.js';

/**
 * Voice library storage.
 *  - Built-in voices: recipes in presets.ts; their anchor clips live in server/voice-presets (committed with the repo,
 *    so the catalog sounds the same everywhere) with index.json holding the exact phrase of each clip.
 *  - User voices ("My voices"): voice-library.json in the media dir; the anchor clip is a /media file.
 * Mock mode keeps both apart (voice-presets-mock/, voice-library.mock.json) so fake clips never mix with real ones.
 */

export type VoiceSource = 'preset' | 'design' | 'capture' | 'clone' | 'mic';

export interface StoredVoice {
  id: string;
  name: string;
  gender: Gender | null;
  age: AgeGroup | null;
  timbre: string[];
  manner: string[];
  description: string;
  /** /media URL of the anchor clip. */
  sample: string;
  /** Exact words of the anchor clip ('' = unknown). Sent as reference_text to OmniVoice. */
  sampleText: string;
  source: VoiceSource;
  createdAt: number;
}

export interface VoiceDto extends Omit<StoredVoice, 'sample'> {
  kind: 'preset' | 'custom';
  ageYears?: number;
  useCase?: string;
  /** Playable URL of the anchor clip; null while a built-in voice has no clip yet. */
  sample: string | null;
  /** Built-in voices: length of the phrase a (re)generation records now, for its price. */
  recipeChars?: number;
}

interface AnchorEntry {
  file: string;
  sampleText: string;
  prompt: string;
  createdAt: number;
}

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Private data, never served: the user voice list, mock-mode built-in clips, the spend counter. VOICE_DATA_DIR overrides. */
export function dataDir(): string {
  return process.env.VOICE_DATA_DIR || path.join(SERVER_ROOT, 'data');
}

export function presetsDir(mock: boolean): string {
  if (mock) return path.join(dataDir(), 'voice-presets-mock');
  return process.env.VOICE_PRESETS_DIR || path.join(SERVER_ROOT, 'voice-presets');
}

function libraryFile(mock: boolean): string {
  return path.join(dataDir(), mock ? 'voice-library.mock.json' : 'voice-library.json');
}

/** The voice lists used to live in the served media folder: move them out once (and drop their stray copies). */
let migrated: Promise<void> | null = null;
function migrateOnce(): Promise<void> {
  migrated ??= (async () => {
    await fs.mkdir(dataDir(), { recursive: true });
    for (const name of ['voice-library.json', 'voice-library.mock.json']) {
      const old = path.join(mediaDir(), name);
      const now = path.join(dataDir(), name);
      const exists = await fs.access(now).then(() => true, () => false);
      if (!exists) await fs.rename(old, now).catch(() => undefined);
      for (const extra of ['.bak', '.tmp']) await fs.rm(old + extra, { force: true });
    }
  })();
  return migrated;
}

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Reads a JSON store. Only a missing file means "empty": a busy file (antivirus, another reader) is retried and a
 * damaged one is an error, because answering "empty" there would make the next write wipe the library.
 */
async function readJson<T>(file: string, fallback: T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return fallback;
      if (BUSY.has(code) && attempt < 6) {
        await sleep(50 * attempt);
        continue;
      }
      throw e;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      console.error(`[voice] ${file} is damaged; the previous version is in ${path.basename(file)}.bak`);
      throw new HttpError(500, 'The voice library file is damaged. Restore it from the .bak copy next to it.');
    }
  }
}

/**
 * Every read-modify-write of the JSON files runs under one lock, so parallel requests (e.g. three built-in voices
 * finishing at once) never lose each other's updates.
 */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomic write (tmp + rename) that keeps the previous version as <file>.bak. Windows refuses the rename while another
 * handle (a reader, antivirus) has the file open: retry, then write in place.
 */
async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const json = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, json, 'utf8');
  await fs.copyFile(file, `${file}.bak`).catch(() => undefined);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      if (!BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await sleep(40 * attempt);
    }
  }
  await fs.writeFile(file, json, 'utf8');
  await fs.rm(tmp, { force: true });
}

// ---------- Built-in voices ----------

async function anchorIndex(mock: boolean): Promise<Record<string, AnchorEntry>> {
  return readJson<Record<string, AnchorEntry>>(path.join(presetsDir(mock), 'index.json'), {});
}

function presetDto(p: VoicePreset, anchor: AnchorEntry | undefined): VoiceDto {
  return {
    id: p.id,
    kind: 'preset',
    name: p.name,
    gender: p.gender,
    age: p.age,
    ageYears: p.ageYears,
    timbre: p.timbre,
    manner: p.manner,
    useCase: p.useCase,
    description: '',
    sample: anchor ? `/api/voice/preset-audio/${encodeURIComponent(anchor.file)}` : null,
    sampleText: anchor?.sampleText ?? p.sampleText,
    recipeChars: p.sampleText.length,
    source: 'preset',
    createdAt: anchor?.createdAt ?? 0,
  };
}

export async function listPresets(mock: boolean): Promise<VoiceDto[]> {
  const index = await anchorIndex(mock);
  return PRESETS.map((p) => presetDto(p, index[p.id]));
}

/** Stores a freshly synthesized anchor clip for a built-in voice (replacing an older one). */
export async function savePresetAnchor(mock: boolean, id: string, buffer: Buffer, ext: string, sampleText: string, prompt: string): Promise<VoiceDto> {
  const preset = findPreset(id);
  if (!preset) throw new HttpError(404, `Unknown built-in voice "${id}"`);
  const dir = presetsDir(mock);
  await fs.mkdir(dir, { recursive: true });
  const file = `${id}-${Date.now().toString(36)}.${ext}`;
  await fs.writeFile(path.join(dir, file), buffer);
  return exclusive(async () => {
    const index = await anchorIndex(mock);
    const old = index[id]?.file;
    index[id] = { file, sampleText, prompt, createdAt: Date.now() };
    await writeJson(path.join(dir, 'index.json'), index);
    if (old && old !== file) {
      // Keep the replaced clip: a regenerated voice can be brought back from archive/.
      await fs.mkdir(path.join(dir, 'archive'), { recursive: true });
      await fs.rename(path.join(dir, old), path.join(dir, 'archive', old)).catch(() => undefined);
    }
    return presetDto(preset, index[id]);
  });
}

// ---------- User voices ----------

async function loadLibrary(mock: boolean): Promise<StoredVoice[]> {
  await migrateOnce();
  const data = await readJson<unknown>(libraryFile(mock), { voices: [] });
  const voices = (data as { voices?: unknown } | null)?.voices;
  // Anything but {"voices": [...]} is damaged: treating it as empty would let the next save wipe it.
  if (!Array.isArray(voices)) throw new HttpError(500, 'The voice library file is damaged. Restore it from the .bak copy next to it.');
  return voices as StoredVoice[];
}

function customDto(v: StoredVoice): VoiceDto {
  return { ...v, kind: 'custom' };
}

export async function listCustom(mock: boolean): Promise<VoiceDto[]> {
  return (await loadLibrary(mock)).sort((a, b) => b.createdAt - a.createdAt).map(customDto);
}

const AUDIO_FILE = /\.(mp3|wav|m4a|aac|ogg|weba|webm|flac)$/i;
const GENDERS = new Set(['female', 'male']);
const AGES = new Set(['young', 'adult', 'mature']);
const SOURCES = new Set(['design', 'capture', 'clone', 'mic']);

function tags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((t) => t.slice(0, 32));
}

function cleanPatch(body: Record<string, unknown>): Partial<StoredVoice> {
  const p: Partial<StoredVoice> = {};
  if (typeof body.name === 'string') {
    const name = body.name.trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Please name the voice');
    p.name = name;
  }
  if ('gender' in body) p.gender = GENDERS.has(String(body.gender)) ? (body.gender as Gender) : null;
  if ('age' in body) p.age = AGES.has(String(body.age)) ? (body.age as AgeGroup) : null;
  if ('timbre' in body) p.timbre = tags(body.timbre);
  if ('manner' in body) p.manner = tags(body.manner);
  if (typeof body.description === 'string') p.description = body.description.trim().slice(0, 500);
  if (typeof body.sampleText === 'string') p.sampleText = body.sampleText.trim().slice(0, 1000);
  return p;
}

export async function createCustom(mock: boolean, body: Record<string, unknown>): Promise<VoiceDto> {
  const sample = typeof body.sample === 'string' ? body.sample : '';
  if (!isMediaUrl(sample) || !AUDIO_FILE.test(sample)) throw new HttpError(400, 'The voice sample must be an uploaded audio file');
  await fs.access(mediaPath(sample)).catch(() => {
    throw new HttpError(404, 'The sample file is missing on the server');
  });
  if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'Please name the voice');
  const voice: StoredVoice = {
    id: `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    gender: null,
    age: null,
    timbre: [],
    manner: [],
    description: '',
    sample,
    sampleText: '',
    source: SOURCES.has(String(body.source)) ? (body.source as VoiceSource) : 'capture',
    createdAt: Date.now(),
    ...cleanPatch(body),
  };
  return exclusive(async () => {
    const voices = await loadLibrary(mock);
    voices.push(voice);
    await writeJson(libraryFile(mock), { voices });
    return customDto(voice);
  });
}

export function updateCustom(mock: boolean, id: string, body: Record<string, unknown>): Promise<VoiceDto> {
  const patch = cleanPatch(body);
  return exclusive(async () => {
    const voices = await loadLibrary(mock);
    const v = voices.find((x) => x.id === id);
    if (!v) throw new HttpError(404, 'Voice not found');
    Object.assign(v, patch);
    await writeJson(libraryFile(mock), { voices });
    return customDto(v);
  });
}

export function deleteCustom(mock: boolean, id: string): Promise<void> {
  return exclusive(async () => {
    const voices = await loadLibrary(mock);
    const next = voices.filter((x) => x.id !== id);
    if (next.length === voices.length) throw new HttpError(404, 'Voice not found');
    // The clip stays in the media dir: history items may still play it.
    await writeJson(libraryFile(mock), { voices: next });
  });
}

// ---------- Reference lookup for synthesis ----------

export interface VoiceReference {
  /** Absolute path of the anchor clip. */
  file: string;
  mime: string;
  sampleText: string;
  name: string;
  gender: Gender | null;
  age: AgeGroup | null;
}

/** Library voice → its anchor clip. null for a built-in voice whose clip has not been made yet. */
export async function voiceReference(mock: boolean, id: string): Promise<VoiceReference | null> {
  const preset = findPreset(id);
  if (preset) {
    const anchor = (await anchorIndex(mock))[id];
    if (!anchor) return null;
    const file = path.join(presetsDir(mock), anchor.file);
    return { file, mime: extToMime(path.extname(file).slice(1)), sampleText: anchor.sampleText, name: preset.name, gender: preset.gender, age: preset.age };
  }
  const v = (await loadLibrary(mock)).find((x) => x.id === id);
  if (!v) throw new HttpError(404, 'Voice not found in the library');
  const file = mediaPath(v.sample);
  return { file, mime: extToMime(path.extname(file).slice(1)), sampleText: v.sampleText, name: v.name, gender: v.gender, age: v.age };
}
