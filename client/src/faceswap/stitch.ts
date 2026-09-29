/**
 * Puts the model's answer back into the photo only where the head is replaced — the old hair, the new hair, both
 * faces and the neck — with a soft edge and the answer's colours matched to the photo on a ring around that zone.
 * This is what the BFS author's InpaintCrop / InpaintStitch nodes do in his workflows: the rest of the photo keeps its
 * own pixels at full resolution (no smeared clothes, no colour shift of the whole frame).
 */
import { dilate, hairRaw, polygonSpans, type HairMap } from './hair';
import type { Box, Face, Pt } from './vision';

export interface Side {
  map: HairMap | null;
  face: Face | null;
}

function fillEllipse(z: Uint8Array, w: number, h: number, cx: number, cy: number, rx: number, ry: number) {
  for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(h, Math.ceil(cy + ry)); y++) {
    const dy = (y + 0.5 - cy) / ry;
    const half = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    const x0 = Math.max(0, Math.ceil(cx - half - 0.5));
    const x1 = Math.min(w - 1, Math.floor(cx + half - 0.5));
    if (x1 >= x0) z.fill(1, y * w + x0, y * w + x1 + 1);
  }
}

/** Box blur of a 0/1 map (two passes each way ≈ a soft falloff over ~2r px) → alpha 0..1. */
function soften(src: Uint8Array, w: number, h: number, r: number): Float32Array {
  const a = Float32Array.from(src);
  if (r < 1) return a;
  const b = new Float32Array(w * h);
  const pass = (from: Float32Array, to: Float32Array, rows: boolean) => {
    const n = rows ? w : h;
    const lines = rows ? h : w;
    const step = rows ? 1 : w;
    for (let line = 0; line < lines; line++) {
      const base = rows ? line * w : line;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += from[base + Math.min(n - 1, Math.max(0, i)) * step];
      for (let i = 0; i < n; i++) {
        to[base + i * step] = sum / (2 * r + 1);
        sum += from[base + Math.min(n - 1, i + r + 1) * step] - from[base + Math.max(0, i - r) * step];
      }
    }
  };
  for (let k = 0; k < 2; k++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  return a;
}

/**
 * The replaced zone as alpha (0..1) on the answer's w × h grid, which covers the photo region `rect`. `old` is in
 * photo coordinates, `neu` (found in the answer) in answer pixels. Null when nothing is known about either head.
 */
export function headZone(w: number, h: number, rect: Box, old: Side, neu: Side): Float32Array | null {
  const k = w / rect.w;
  const toAns = (p: Pt): Pt => ({ x: (p.x - rect.x) * k, y: (p.y - rect.y) * k });
  const z = new Uint8Array(w * h);
  const sizes: number[] = [];
  if (old.map) {
    const m = hairRaw(old.map, rect, w, h);
    for (let i = 0; i < z.length; i++) z[i] |= m[i];
  }
  if (neu.map) {
    const m = hairRaw(neu.map, { x: 0, y: 0, w, h }, w, h);
    for (let i = 0; i < z.length; i++) z[i] |= m[i];
  }
  const faces: Array<{ outline: Pt[]; chin: Pt; size: number }> = [];
  if (old.face) faces.push({ outline: old.face.outline.map(toAns), chin: toAns(old.face.chin), size: old.face.size * k });
  if (neu.face) faces.push({ outline: neu.face.outline, chin: neu.face.chin, size: neu.face.size });
  for (const f of faces) {
    sizes.push(f.size);
    // The face oval grown by 10%, and the neck under the chin.
    let cx = 0;
    let cy = 0;
    for (const p of f.outline) {
      cx += p.x;
      cy += p.y;
    }
    cx /= f.outline.length || 1;
    cy /= f.outline.length || 1;
    polygonSpans(
      f.outline.map((p) => ({ x: cx + (p.x - cx) * 1.1, y: cy + (p.y - cy) * 1.1 })),
      w,
      h,
      (row, a, b) => z.fill(1, row * w + a, row * w + b + 1),
    );
    fillEllipse(z, w, h, f.chin.x, f.chin.y + 0.2 * f.size, 0.5 * f.size, 0.45 * f.size);
  }
  if (!sizes.length && !old.map && !neu.map) return null;
  const s = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0.15 * Math.min(w, h);
  const grown = dilate(z, w, h, Math.round(0.12 * s));
  return soften(grown, w, h, Math.max(1, Math.round(0.06 * s)));
}

/**
 * The photo with the answer (which covers the photo region `rect`) blended in by `alpha` (on the answer's grid).
 * The answer's colours are matched to the photo on the zone's soft edge; the zone fades out at the region's edges
 * that lie inside the photo.
 */
export function stitch(photo: HTMLCanvasElement, rect: Box, answer: CanvasImageSource, aw: number, ah: number, alpha: Float32Array): HTMLCanvasElement {
  const W = photo.width;
  const H = photo.height;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const og = out.getContext('2d', { willReadFrequently: true })!;
  og.drawImage(photo, 0, 0);
  const rx = Math.round(rect.x);
  const ry = Math.round(rect.y);
  const rw = Math.max(1, Math.min(W - rx, Math.round(rect.w)));
  const rh = Math.max(1, Math.min(H - ry, Math.round(rect.h)));
  const up = document.createElement('canvas');
  up.width = rw;
  up.height = rh;
  const ug = up.getContext('2d', { willReadFrequently: true })!;
  ug.imageSmoothingQuality = 'high';
  ug.drawImage(answer, 0, 0, rw, rh);
  const o = og.getImageData(rx, ry, rw, rh);
  const u = ug.getImageData(0, 0, rw, rh).data;
  const od = o.data;

  // Alpha at full size (bilinear), faded over the region's edges that lie inside the photo.
  const a = new Float32Array(rw * rh);
  const fw = Math.max(8, 0.04 * Math.min(rw, rh));
  const L = rx > 0;
  const T = ry > 0;
  const R = rx + rw < W - 1;
  const B = ry + rh < H - 1;
  for (let y = 0; y < rh; y++) {
    const sy = Math.min(ah - 1, Math.max(0, ((y + 0.5) * ah) / rh - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(ah - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < rw; x++) {
      const sx = Math.min(aw - 1, Math.max(0, ((x + 0.5) * aw) / rw - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(aw - 1, x0 + 1);
      const fx = sx - x0;
      let v =
        (alpha[y0 * aw + x0] * (1 - fx) + alpha[y0 * aw + x1] * fx) * (1 - fy) + (alpha[y1 * aw + x0] * (1 - fx) + alpha[y1 * aw + x1] * fx) * fy;
      let d = Infinity;
      if (L) d = Math.min(d, x);
      if (T) d = Math.min(d, y);
      if (R) d = Math.min(d, rw - 1 - x);
      if (B) d = Math.min(d, rh - 1 - y);
      if (d !== Infinity) {
        const t = Math.min(1, d / fw);
        v *= t * t * (3 - 2 * t);
      }
      a[y * rw + x] = v;
    }
  }

  // Colour match on the zone's outer soft edge (the model shifts the colours of the whole picture a little).
  const st = [0, 1, 2].map(() => ({ so: 0, sa: 0, qo: 0, qa: 0, n: 0 }));
  for (let i = 0; i < a.length; i += 3) {
    if (a[i] <= 0.02 || a[i] >= 0.35) continue;
    for (let c = 0; c < 3; c++) {
      const s = st[c];
      s.so += od[4 * i + c];
      s.sa += u[4 * i + c];
      s.qo += od[4 * i + c] ** 2;
      s.qa += u[4 * i + c] ** 2;
      s.n++;
    }
  }
  const fix = st.map((s) => {
    if (s.n < 200) return { gain: 1, offset: 0 };
    const mo = s.so / s.n;
    const ma = s.sa / s.n;
    const so = Math.sqrt(Math.max(1, s.qo / s.n - mo * mo));
    const sa = Math.sqrt(Math.max(1, s.qa / s.n - ma * ma));
    const gain = Math.min(1.2, Math.max(0.85, so / sa));
    return { gain, offset: Math.min(30, Math.max(-30, mo - gain * ma)) };
  });

  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t <= 0.001) continue;
    for (let c = 0; c < 3; c++) {
      const v = u[4 * i + c] * fix[c].gain + fix[c].offset;
      od[4 * i + c] = od[4 * i + c] + (v - od[4 * i + c]) * t;
    }
  }
  og.putImageData(o, rx, ry);
  up.width = 0;
  return out;
}

/** A soft zone (alpha 0..1) from 0/1 masks on the same w × h grid: their union, grown and feathered by the face size. */
export function zoneFrom(masks: Uint8Array[], w: number, h: number, faceSize: number): Float32Array | null {
  const z = new Uint8Array(w * h);
  let any = false;
  for (const m of masks) {
    for (let i = 0; i < z.length; i++) {
      if (!m[i]) continue;
      z[i] = 1;
      any = true;
    }
  }
  if (!any) return null;
  const grown = dilate(z, w, h, Math.round(0.1 * faceSize));
  return soften(grown, w, h, Math.max(1, Math.round(0.05 * faceSize)));
}
