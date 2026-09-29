import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDataUrl, toDataUrl, fetchRetry } from '../util.js';

/** All generated / uploaded media lives in server/storage and is served under /media/<file>. */
const DIR = process.env.MEDIA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../storage');

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  // Voice Studio sources that only ffmpeg reads (never served back under /media).
  'video/x-ms-wmv': 'wmv',
  'video/x-ms-asf': 'asf',
  'audio/x-ms-wma': 'wma',
  'video/x-flv': 'flv',
  'video/mp2t': 'ts',
  'video/mpeg': 'mpg',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/amr': 'amr',
  'audio/x-caf': 'caf',
  'application/json': 'json',
};

export function mediaDir(): string {
  return DIR;
}

export async function ensureMediaDir(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
}

function newName(prefix: string, ext: string): string {
  const stamp = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix.replace(/[^a-z0-9_-]/gi, '')}-${stamp}-${rnd}.${ext}`;
}

/** Extensions a browser would treat as a page or script: never produced from a client-supplied type. */
const UNSAFE_EXT = /^(html?|xhtml|xht|svg|svgz|xml|xsl|js|mjs|cjs|css|php|json|shtml)$/i;

export function mimeToExt(mime: string): string {
  const known = EXT[mime.toLowerCase()];
  if (known) return known;
  const guess = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  return UNSAFE_EXT.test(guess) ? 'bin' : guess;
}

export function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  for (const [mime, x] of Object.entries(EXT)) if (x === e) return mime;
  return 'application/octet-stream';
}

/** Saves raw bytes into the media dir; returns the public URL (/media/<file>). */
export async function saveBuffer(buffer: Buffer, mime: string, prefix = 'media'): Promise<{ url: string; file: string; mime: string }> {
  await ensureMediaDir();
  const file = newName(prefix, mimeToExt(mime));
  await fs.writeFile(path.join(DIR, file), buffer);
  return { url: `/media/${file}`, file, mime };
}

export async function saveDataUrl(dataUrl: string, prefix = 'media'): Promise<{ url: string; file: string; mime: string }> {
  const { mime, buffer } = parseDataUrl(dataUrl);
  return saveBuffer(buffer, mime, prefix);
}

/** Resolves a /media URL to an absolute file path (rejects anything outside the media dir). */
export function mediaPath(url: string): string {
  const name = path.basename(url.replace(/^\/media\//, '').split('?')[0]);
  if (!name || name.includes('..')) throw new Error('Invalid media path');
  return path.join(DIR, name);
}

export function isMediaUrl(s: string): boolean {
  return typeof s === 'string' && s.startsWith('/media/');
}

/** Reads any input (data URL, /media URL, http URL) into bytes. */
export async function readInput(input: string): Promise<{ mime: string; buffer: Buffer; filename: string }> {
  if (input.startsWith('data:')) {
    const { mime, buffer } = parseDataUrl(input);
    return { mime, buffer, filename: `input.${mimeToExt(mime)}` };
  }
  if (isMediaUrl(input)) {
    const p = mediaPath(input);
    const buffer = await fs.readFile(p);
    return { mime: extToMime(path.extname(p).slice(1)), buffer, filename: path.basename(p) };
  }
  if (/^https?:\/\//.test(input)) {
    const res = await fetchRetry(input, undefined, 3, 'download input');
    if (!res.ok) throw new Error(`Failed to download input (${res.status})`);
    const mime = res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    return { mime, buffer: Buffer.from(await res.arrayBuffer()), filename: path.basename(new URL(input).pathname) || 'input' };
  }
  throw new Error('Unsupported input reference');
}

/** Any input → data URL (what Seedream-style endpoints accept directly). */
export async function inputAsDataUrl(input: string): Promise<string> {
  if (input.startsWith('data:')) return input;
  const { mime, buffer } = await readInput(input);
  return toDataUrl(mime, buffer);
}

/** Downloads a remote result and stores it locally; returns the /media URL. */
export async function storeRemote(url: string, prefix: string, fallbackMime = 'application/octet-stream'): Promise<{ url: string; mime: string; bytes: number }> {
  const res = await fetchRetry(url, undefined, 4, 'download result');
  if (!res.ok) throw new Error(`Failed to download result (${res.status})`);
  let mime = res.headers.get('content-type')?.split(';')[0] || fallbackMime;
  if (mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    const ext = path.extname(new URL(url).pathname).slice(1);
    if (ext) mime = extToMime(ext);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const saved = await saveBuffer(buffer, mime, prefix);
  return { url: saved.url, mime, bytes: buffer.byteLength };
}
