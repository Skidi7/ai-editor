/** Parses a data URL into its mime type and raw bytes. */
export function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('Invalid data URL');
  const mime = m[1];
  const payload = m[3];
  const buffer = m[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mime, buffer };
}

export function toDataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `fetch` that retries on network-level failures (DNS, reset, idle timeout) — not on HTTP error statuses. */
export async function fetchRetry(url: string, init?: RequestInit, tries = 3, label = 'request'): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastError = e;
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      console.warn(`[net] ${label} attempt ${attempt}/${tries} failed: ${(e as Error).message}${cause?.code ? ` (${cause.code})` : ''}`);
      if (attempt < tries) await sleep(800 * attempt);
    }
  }
  const cause = (lastError as { cause?: { code?: string; message?: string } }).cause;
  throw new Error(`${label}: ${(lastError as Error).message}${cause?.code || cause?.message ? ` (${cause.code || cause.message})` : ''}`);
}

/** Downloads a remote image and returns it as a data URL so the browser can draw it on a canvas without CORS issues. */
export async function fetchAsDataUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  const res = await fetchRetry(url, undefined, 4, 'download result image');
  if (!res.ok) throw new Error(`Failed to download result image (${res.status})`);
  const mime = res.headers.get('content-type')?.split(';')[0] || 'image/png';
  const buffer = Buffer.from(await res.arrayBuffer());
  return toDataUrl(mime, buffer);
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const { mime, buffer } = parseDataUrl(dataUrl);
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return new Blob([bytes], { type: mime });
}

/**
 * Seedream custom sizes must be within 1024..2048 px per side. Scales the requested size
 * proportionally so it fits that range; falls back to the closest valid box if impossible.
 */
export function fitSeedreamSize(width: number, height: number, min = 1024, max = 2048): { width: number; height: number } {
  let w = width;
  let h = height;
  const maxSide = Math.max(w, h);
  const minSide = Math.min(w, h);
  if (maxSide > max) {
    const k = max / maxSide;
    w *= k;
    h *= k;
  }
  if (Math.min(w, h) < min) {
    const k = min / Math.min(w, h);
    w *= k;
    h *= k;
  }
  void minSide;
  w = Math.round(Math.min(max, Math.max(min, w)) / 8) * 8;
  h = Math.round(Math.min(max, Math.max(min, h)) / 8) * 8;
  return { width: w, height: h };
}
