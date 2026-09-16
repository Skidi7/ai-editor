import type { Doc, Rect } from './types';

let counter = 0;
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable');
  return ctx;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

export async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvasFromImage(img: HTMLImageElement): HTMLCanvasElement {
  const c = createCanvas(img.naturalWidth, img.naturalHeight);
  ctx2d(c).drawImage(img, 0, 0);
  return c;
}

/** Draws `src` into a new canvas of the given size (stretching). */
export function resizeCanvas(src: HTMLCanvasElement | HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const c = createCanvas(width, height);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Returns a copy scaled so its longest side is at most `maxSide` (or the same canvas if already small enough). */
export function downscaleToFit(src: HTMLCanvasElement, maxSide: number): { canvas: HTMLCanvasElement; scale: number } {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (k >= 1) return { canvas: src, scale: 1 };
  return { canvas: resizeCanvas(src, Math.round(src.width * k), Math.round(src.height * k)), scale: k };
}

export function flattenDoc(doc: Doc): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    ctx.drawImage(layer.canvas, 0, 0);
  }
  return c;
}

export function canvasToDataUrl(c: HTMLCanvasElement, type: 'image/png' | 'image/jpeg' = 'image/png', quality = 0.92): string {
  return c.toDataURL(type, quality);
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type);
  });
}

export function downloadCanvas(c: HTMLCanvasElement, filename: string) {
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = filename;
  a.click();
}

/** Keeps `src` only where `mask` has alpha (result has transparent pixels elsewhere). */
export function compositeThroughMask(src: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  const ctx = ctx2d(c);
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

/** Softens mask edges with a gaussian blur of `radius` px. */
export function featherMask(mask: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius <= 0) return mask;
  const c = createCanvas(mask.width, mask.height);
  const ctx = ctx2d(c);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(mask, 0, 0);
  ctx.filter = 'none';
  return c;
}

/** Grows the mask by ~`px` pixels (blur + threshold). */
export function dilateMask(mask: HTMLCanvasElement, px: number): HTMLCanvasElement {
  if (px <= 0) return mask;
  const blurred = featherMask(mask, px);
  const ctx = ctx2d(blurred);
  const img = ctx.getImageData(0, 0, blurred.width, blurred.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] > 2 ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return blurred;
}

/** Cuts/extends every layer to `rect` (document coordinates). Areas outside the old document become transparent. */
export function cropDoc(doc: Doc, rect: Rect): Doc {
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const ox = Math.round(rect.x);
  const oy = Math.round(rect.y);
  return {
    width: w,
    height: h,
    layers: doc.layers.map((l) => {
      const c = createCanvas(w, h);
      ctx2d(c).drawImage(l.canvas, -ox, -oy);
      return { ...l, canvas: c };
    }),
  };
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** Aspect ratios every Seedream provider can output exactly; regions sent to the model are padded to one of these. */
export const SUPPORTED_RATIOS: number[] = [1, 1 / 2, 2, 1 / 3, 3, 2 / 3, 3 / 2, 3 / 4, 4 / 3, 4 / 5, 5 / 4, 9 / 16, 16 / 9, 9 / 21, 21 / 9];

export function nearestRatio(w: number, h: number): number {
  const r = w / h;
  let best = SUPPORTED_RATIOS[0];
  for (const c of SUPPORTED_RATIOS) if (Math.abs(Math.log(c / r)) < Math.abs(Math.log(best / r))) best = c;
  return best;
}

/** Grows `r` (keeping its centre) until it has exactly the given aspect ratio. */
export function expandRectToRatio(r: Rect, ratio: number): Rect {
  let w = r.w;
  let h = r.h;
  if (w / h < ratio) w = h * ratio;
  else h = w / ratio;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** Slides `r` inside a (0,0,bw,bh) box where it fits; where it does not fit it is centred on that axis. */
export function shiftRectIntoBounds(r: Rect, bw: number, bh: number): Rect {
  let { x, y } = r;
  if (r.w <= bw) x = Math.min(Math.max(0, x), bw - r.w);
  else x = (bw - r.w) / 2;
  if (r.h <= bh) y = Math.min(Math.max(0, y), bh - r.h);
  else y = (bh - r.h) / 2;
  return { x, y, w: r.w, h: r.h };
}

export function roundRect(r: Rect): Rect {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, w: Math.max(1, Math.round(r.x + r.w) - x), h: Math.max(1, Math.round(r.y + r.h) - y) };
}

/**
 * Copies `rect` (document coordinates, may extend past the source) into a new canvas.
 * Out-of-bounds pixels are filled by stretching the nearest edge ('edge'), with neutral gray ('gray'),
 * or left transparent ('transparent').
 */
export type PadMode = 'edge' | 'mirror' | 'gray' | 'white' | 'transparent';

export function extractRegion(src: HTMLCanvasElement, rect: Rect, pad: PadMode): HTMLCanvasElement {
  const r = roundRect(rect);
  const c = createCanvas(r.w, r.h);
  const ctx = ctx2d(c);
  if (pad === 'gray' || pad === 'white') {
    ctx.fillStyle = pad === 'gray' ? '#808080' : '#ffffff';
    ctx.fillRect(0, 0, r.w, r.h);
  }
  ctx.drawImage(src, -r.x, -r.y);
  if (pad !== 'edge' && pad !== 'mirror') return c;

  // Position of the source inside the region.
  const ox = -r.x;
  const oy = -r.y;
  const sx1 = Math.max(0, ox);
  const sy1 = Math.max(0, oy);
  const sx2 = Math.min(r.w, ox + src.width);
  const sy2 = Math.min(r.h, oy + src.height);
  if (sx2 <= sx1 || sy2 <= sy1) return c;
  ctx.imageSmoothingEnabled = pad === 'mirror';

  if (pad === 'edge') {
    // Horizontal strips first (over the source's row range), then vertical strips over the full width so corners fill.
    let snap = cloneCanvas(c);
    if (sx1 > 0) ctx.drawImage(snap, sx1, sy1, 1, sy2 - sy1, 0, sy1, sx1, sy2 - sy1);
    if (sx2 < r.w) ctx.drawImage(snap, sx2 - 1, sy1, 1, sy2 - sy1, sx2, sy1, r.w - sx2, sy2 - sy1);
    snap = cloneCanvas(c);
    if (sy1 > 0) ctx.drawImage(snap, 0, sy1, r.w, 1, 0, 0, r.w, sy1);
    if (sy2 < r.h) ctx.drawImage(snap, 0, sy2 - 1, r.w, 1, 0, sy2, r.w, r.h - sy2);
    return c;
  }

  // Mirror padding: reflect the adjacent slice of the image into the empty strip (stretched if the strip is wider).
  const sw = sx2 - sx1;
  const sh = sy2 - sy1;
  let snap = cloneCanvas(c);
  if (sx1 > 0) {
    const take = Math.min(sx1, sw);
    ctx.save();
    ctx.translate(sx1, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(snap, sx1, sy1, take, sh, 0, sy1, sx1, sh);
    ctx.restore();
  }
  if (sx2 < r.w) {
    const take = Math.min(r.w - sx2, sw);
    ctx.save();
    ctx.translate(r.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(snap, sx2 - take, sy1, take, sh, 0, sy1, r.w - sx2, sh);
    ctx.restore();
  }
  snap = cloneCanvas(c);
  if (sy1 > 0) {
    const take = Math.min(sy1, sh);
    ctx.save();
    ctx.translate(0, sy1);
    ctx.scale(1, -1);
    ctx.drawImage(snap, 0, sy1, r.w, take, 0, 0, r.w, sy1);
    ctx.restore();
  }
  if (sy2 < r.h) {
    const take = Math.min(r.h - sy2, sh);
    ctx.save();
    ctx.translate(0, r.h);
    ctx.scale(1, -1);
    ctx.drawImage(snap, 0, sy2 - take, r.w, take, 0, 0, r.w, r.h - sy2);
    ctx.restore();
  }
  return c;
}

/** Alpha channel of `src` as a white mask canvas. */
export function alphaToMask(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  const ctx = ctx2d(c);
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/**
 * Cleans up a cut-out's alpha: shrinks the edge by `erode` px (removes the halo of old background) and softens
 * it over `feather` px. Works on a blurred alpha so hair-like detail is kept.
 */
export function refineAlpha(src: HTMLCanvasElement, erode: number, feather: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const r = Math.max(1, Math.round(erode + feather));
  const orig = ctx2d(src).getImageData(0, 0, w, h);
  const blurred = ctx2d(featherMask(alphaToMask(src), r)).getImageData(0, 0, w, h).data;
  const d = orig.data;
  for (let i = 3; i < d.length; i += 4) {
    const b = blurred[i] / 255;
    // Distance from the original edge (px, positive = inside) reconstructed from the blurred ramp.
    const dist = (b - 0.5) * 2 * r;
    const a = Math.min(1, Math.max(0, (dist - erode) / Math.max(0.5, feather) + 0.5));
    d[i] = Math.min(d[i], Math.round(a * 255));
  }
  const out = createCanvas(w, h);
  ctx2d(out).putImageData(orig, 0, 0);
  return out;
}

/** Center-crops `src` to the given aspect ratio and resizes it to `w`×`h` (no stretching). */
export function coverResize(src: HTMLCanvasElement | HTMLImageElement, w: number, h: number): HTMLCanvasElement {
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const k = Math.max(w / sw, h / sh);
  const cw = w / k;
  const ch = h / k;
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
  return c;
}


/**
 * Removes global tone drift from a generated region: measures the per-channel mean difference between
 * `result` and `reference` on pixels OUTSIDE `mask` (which the model was told not to change) and subtracts it.
 */
export function matchTone(result: HTMLCanvasElement, reference: HTMLCanvasElement, mask: HTMLCanvasElement | null) {
  const w = result.width;
  const h = result.height;
  if (reference.width !== w || reference.height !== h) return;
  const rctx = ctx2d(result);
  const res = rctx.getImageData(0, 0, w, h);
  const ref = ctx2d(reference).getImageData(0, 0, w, h).data;
  const m = mask ? ctx2d(mask).getImageData(0, 0, w, h).data : null;
  const sum = [0, 0, 0];
  let n = 0;
  const d = res.data;
  for (let i = 0; i < d.length; i += 4) {
    if (m && m[i + 3] > 8) continue;
    if (ref[i + 3] < 200) continue;
    sum[0] += ref[i] - d[i];
    sum[1] += ref[i + 1] - d[i + 1];
    sum[2] += ref[i + 2] - d[i + 2];
    n++;
  }
  if (n < 500) return;
  const off = sum.map((s) => Math.max(-40, Math.min(40, s / n)));
  if (off.every((o) => Math.abs(o) < 0.5)) return;
  for (let i = 0; i < d.length; i += 4) {
    d[i] += off[0];
    d[i + 1] += off[1];
    d[i + 2] += off[2];
  }
  rctx.putImageData(res, 0, 0);
}

/** Small JPEG thumbnail as data URL (for backdrop / filmstrip). */
export function thumbnailUrl(src: HTMLCanvasElement, maxSide: number): string {
  return canvasToDataUrl(downscaleToFit(src, maxSide).canvas, 'image/jpeg', 0.8);
}
