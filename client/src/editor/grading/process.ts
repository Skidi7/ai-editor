import type { GradeParams } from './params';
import { type MatchStats, transferColor } from './colorMatch';

export interface MatchInput {
  src: MatchStats;
  ref: MatchStats;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Separable box blur (3 passes ≈ gaussian) on a 3-channel float buffer. Returns a new buffer. */
function blur3(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return src.slice();
  let a = src.slice();
  let b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += a[(row + Math.min(w - 1, Math.max(0, x))) * 3 + c];
        for (let x = 0; x < w; x++) {
          b[(row + x) * 3 + c] = acc / (2 * r + 1);
          const xo = Math.max(0, x - r);
          const xi = Math.min(w - 1, x + r + 1);
          acc += a[(row + xi) * 3 + c] - a[(row + xo) * 3 + c];
        }
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += b[(Math.min(h - 1, Math.max(0, y)) * w + x) * 3 + c];
        for (let y = 0; y < h; y++) {
          a[(y * w + x) * 3 + c] = acc / (2 * r + 1);
          const yo = Math.max(0, y - r);
          const yi = Math.min(h - 1, y + r + 1);
          acc += b[(yi * w + x) * 3 + c] - b[(yo * w + x) * 3 + c];
        }
      }
    }
  }
  void b;
  b = a;
  return b;
}

/** Deterministic PRNG so preview and final render show the same grain. */
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Applies the full grading pipeline. Spatial effect radii are expressed relative to image size so a
 * downscaled preview and the full-resolution render look the same.
 */
export function applyGrade(input: ImageData, p: GradeParams, match?: MatchInput): ImageData {
  const w = input.width;
  const h = input.height;
  const n = w * h;
  const d = input.data;
  const rgb = new Float32Array(n * 3);
  const alpha = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = d[i * 4] / 255;
    rgb[i * 3 + 1] = d[i * 4 + 1] / 255;
    rgb[i * 3 + 2] = d[i * 4 + 2] / 255;
    alpha[i] = d[i * 4 + 3];
  }
  const minSide = Math.min(w, h);

  // 1. Reference match
  if (p.match && match) transferColor(rgb, n, match.src, match.ref, p.matchStrength / 100);

  // 2. Per-pixel tonal & colour work
  const expMul = p.exposure ? Math.pow(2, p.exposureEv) : 1;
  const hl = p.exposure ? p.highlights / 100 : 0;
  const sh = p.exposure ? p.shadows / 100 : 0;
  const temp = p.colorCorrect ? p.temperature / 100 : 0;
  const tint = p.colorCorrect ? p.tint / 100 : 0;
  const sat = p.colorCorrect ? p.saturation / 100 : 0;
  const vib = p.colorCorrect ? p.vibrance / 100 : 0;
  const con = p.colorCorrect ? p.contrast / 100 : 0;
  const fade = p.fade / 100;
  const split = p.splitAmount / 100;
  const ss = p.splitShadow.map((v) => v / 255 - 0.5);
  const shl = p.splitHighlight.map((v) => v / 255 - 0.5);

  for (let i = 0; i < n; i++) {
    const o = i * 3;
    let r = rgb[o] * expMul;
    let g = rgb[o + 1] * expMul;
    let b = rgb[o + 2] * expMul;

    if (hl !== 0 || sh !== 0) {
      const l = clamp01(lum(r, g, b));
      const f = 1 + sh * 0.7 * (1 - l) * (1 - l) + hl * 0.7 * l * l;
      r *= f;
      g *= f;
      b *= f;
    }
    if (temp !== 0) {
      r *= 1 + 0.18 * temp;
      b *= 1 - 0.18 * temp;
      g *= 1 + 0.04 * temp;
    }
    if (tint !== 0) {
      g *= 1 - 0.12 * tint;
      r *= 1 + 0.05 * tint;
      b *= 1 + 0.05 * tint;
    }
    if (con !== 0) {
      const k = con > 0 ? 1 + con * 0.9 : 1 + con * 0.6;
      r = (r - 0.5) * k + 0.5;
      g = (g - 0.5) * k + 0.5;
      b = (b - 0.5) * k + 0.5;
    }
    if (sat !== 0 || vib !== 0) {
      const l = lum(r, g, b);
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const s = mx - mn;
      const k = 1 + sat + vib * (1 - Math.min(1, s * 1.5));
      r = l + (r - l) * k;
      g = l + (g - l) * k;
      b = l + (b - l) * k;
    }
    if (p.bw) {
      const l = 0.28 * r + 0.62 * g + 0.1 * b;
      r = g = b = l;
    }
    if (split > 0) {
      const l = clamp01(lum(r, g, b));
      const ws = (1 - l) * (1 - l) * split * 0.6;
      const wh = l * l * split * 0.6;
      r += ss[0] * ws + shl[0] * wh;
      g += ss[1] * ws + shl[1] * wh;
      b += ss[2] * ws + shl[2] * wh;
    }
    if (fade > 0) {
      const f = fade * 0.28;
      r = r + f * (1 - r) * (1 - r);
      g = g + f * (1 - g) * (1 - g);
      b = b + f * (1 - b) * (1 - b);
    }
    rgb[o] = clamp01(r);
    rgb[o + 1] = clamp01(g);
    rgb[o + 2] = clamp01(b);
  }

  // 3. Spatial effects
  if (p.soften && p.softenAmount > 0) {
    const radius = (p.softenAmount / 100) * minSide * 0.012;
    const blurred = blur3(rgb, w, h, radius);
    const k = Math.min(1, p.softenAmount / 100 + 0.2);
    for (let i = 0; i < rgb.length; i++) rgb[i] = rgb[i] + (blurred[i] - rgb[i]) * k;
  }

  if (p.lens) {
    if (p.chromatic > 0) {
      const shift = (p.chromatic / 100) * minSide * 0.01;
      const cx = w / 2;
      const cy = h / 2;
      const src = rgb.slice();
      const sample = (x: number, y: number, c: number) => {
        const xi = Math.min(w - 1, Math.max(0, Math.round(x)));
        const yi = Math.min(h - 1, Math.max(0, Math.round(y)));
        return src[(yi * w + xi) * 3 + c];
      };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x - cx) / cx;
          const dy = (y - cy) / cy;
          const o = (y * w + x) * 3;
          rgb[o] = sample(x + dx * shift, y + dy * shift, 0);
          rgb[o + 2] = sample(x - dx * shift, y - dy * shift, 2);
        }
      }
    }
    if (p.sharpen > 0) {
      const blurred = blur3(rgb, w, h, Math.max(1, minSide * 0.002));
      const k = (p.sharpen / 100) * 1.5;
      for (let i = 0; i < rgb.length; i++) rgb[i] = clamp01(rgb[i] + (rgb[i] - blurred[i]) * k);
    }
    if (p.vignette > 0) {
      const k = p.vignette / 100;
      const cx = w / 2;
      const cy = h / 2;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x - cx) / cx;
          const dy = (y - cy) / cy;
          const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
          const v = 1 - k * clamp01((dist - 0.35) / 0.65) ** 1.6 * 0.95;
          const o = (y * w + x) * 3;
          rgb[o] *= v;
          rgb[o + 1] *= v;
          rgb[o + 2] *= v;
        }
      }
    }
  }

  if (p.grain && p.grainAmount > 0) {
    const size = Math.max(1, p.grainSize * (minSide / 1000));
    const gw = Math.ceil(w / size) + 1;
    const gh = Math.ceil(h / size) + 1;
    const rnd = mulberry32(1337);
    const noise = new Float32Array(gw * gh);
    for (let i = 0; i < noise.length; i++) noise[i] = rnd() - 0.5;
    const amt = (p.grainAmount / 100) * 0.35;
    for (let y = 0; y < h; y++) {
      const gy = Math.floor(y / size);
      for (let x = 0; x < w; x++) {
        const nval = noise[gy * gw + Math.floor(x / size)];
        const o = (y * w + x) * 3;
        const l = lum(rgb[o], rgb[o + 1], rgb[o + 2]);
        const weight = 1 - Math.abs(l - 0.5) * 1.2; // strongest in midtones
        const g = nval * amt * Math.max(0.15, weight);
        rgb[o] = clamp01(rgb[o] + g);
        rgb[o + 1] = clamp01(rgb[o + 1] + g);
        rgb[o + 2] = clamp01(rgb[o + 2] + g);
      }
    }
  }

  const out = new ImageData(w, h);
  const od = out.data;
  for (let i = 0; i < n; i++) {
    od[i * 4] = rgb[i * 3] * 255;
    od[i * 4 + 1] = rgb[i * 3 + 1] * 255;
    od[i * 4 + 2] = rgb[i * 3 + 2] * 255;
    od[i * 4 + 3] = alpha[i];
  }
  return out;
}
