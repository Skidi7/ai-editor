/**
 * Reinhard et al. "Color Transfer between Images" — statistics in the decorrelated lαβ space.
 */
export interface MatchStats {
  mean: [number, number, number];
  std: [number, number, number];
}

const EPS = 1e-4;
const S3 = 1 / Math.sqrt(3);
const S6 = 1 / Math.sqrt(6);
const S2 = 1 / Math.sqrt(2);

export function rgbToLab(r: number, g: number, b: number, out: Float32Array, o: number) {
  const L = Math.log10(0.3811 * r + 0.5783 * g + 0.0402 * b + EPS);
  const M = Math.log10(0.1967 * r + 0.7244 * g + 0.0782 * b + EPS);
  const S = Math.log10(0.0241 * r + 0.1288 * g + 0.8444 * b + EPS);
  out[o] = S3 * (L + M + S);
  out[o + 1] = S6 * (L + M - 2 * S);
  out[o + 2] = S2 * (L - M);
}

export function labToRgb(l: number, a: number, b: number, out: Float32Array, o: number) {
  const L = Math.pow(10, S3 * l + S6 * a + S2 * b);
  const M = Math.pow(10, S3 * l + S6 * a - S2 * b);
  const S = Math.pow(10, S3 * l - 2 * S6 * a);
  out[o] = 4.4679 * L - 3.5873 * M + 0.1193 * S;
  out[o + 1] = -1.2186 * L + 2.3809 * M - 0.1624 * S;
  out[o + 2] = 0.0497 * L - 0.2439 * M + 1.2045 * S;
}

/** Computes lαβ mean/std for an image (values in 0..1 floats, 3 per pixel). */
export function computeStats(rgb: Float32Array, count: number): MatchStats {
  const lab = new Float32Array(3);
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], lab, 0);
    for (let c = 0; c < 3; c++) {
      sum[c] += lab[c];
      sq[c] += lab[c] * lab[c];
    }
  }
  const mean: [number, number, number] = [sum[0] / count, sum[1] / count, sum[2] / count];
  const std: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) std[c] = Math.sqrt(Math.max(1e-8, sq[c] / count - mean[c] * mean[c]));
  return { mean, std };
}

export function statsFromImageData(img: ImageData): MatchStats {
  const n = img.width * img.height;
  const rgb = new Float32Array(n * 3);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = d[i * 4] / 255;
    rgb[i * 3 + 1] = d[i * 4 + 1] / 255;
    rgb[i * 3 + 2] = d[i * 4 + 2] / 255;
  }
  return computeStats(rgb, n);
}

/** Transfers `ref` statistics onto `rgb` (in place), blended by `strength` 0..1. */
export function transferColor(rgb: Float32Array, count: number, src: MatchStats, ref: MatchStats, strength: number) {
  const lab = new Float32Array(3);
  const out = new Float32Array(3);
  const k = [ref.std[0] / src.std[0], ref.std[1] / src.std[1], ref.std[2] / src.std[2]];
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    rgbToLab(rgb[o], rgb[o + 1], rgb[o + 2], lab, 0);
    for (let c = 0; c < 3; c++) lab[c] = (lab[c] - src.mean[c]) * k[c] + ref.mean[c];
    labToRgb(lab[0], lab[1], lab[2], out, 0);
    for (let c = 0; c < 3; c++) rgb[o + c] = rgb[o + c] + (out[c] - rgb[o + c]) * strength;
  }
}
