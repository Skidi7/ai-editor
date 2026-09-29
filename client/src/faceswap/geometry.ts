/**
 * Which part of each photo goes to the model. The output always has one of the model's accepted aspect ratios, so
 * crops are cut to one of them and the answer maps back 1:1.
 */
import { headCenter, type Box, type Face } from './vision';

export type Resolution = '1k' | '1.5k' | '2k';

const ASPECTS: Array<[string, number]> = [
  ['1:1', 1],
  ['4:5', 4 / 5],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
  ['9:16', 9 / 16],
  ['1:2', 1 / 2],
  ['5:4', 5 / 4],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
  ['16:9', 16 / 9],
  ['2:1', 2],
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function nearestAspect(r: number): [string, number] {
  let best = ASPECTS[0];
  for (const a of ASPECTS) if (Math.abs(Math.log(a[1] / r)) < Math.abs(Math.log(best[1] / r))) best = a;
  return best;
}

/** The largest crop of an accepted aspect ratio centred on the photo (the whole photo, minus a sliver). */
export function wholeCrop(W: number, H: number): { rect: Box; aspect: string } {
  const [label, r] = nearestAspect(W / H);
  const w = Math.floor(Math.min(W, H * r));
  const h = Math.floor(Math.min(H, W / r));
  return { rect: { x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2), w, h }, aspect: label };
}

/**
 * Zoom on a small head (a person far away): a portrait crop around the head that still shows the upper body
 * (about 4.5 × 6 face sizes, head in the upper third) — the model gets many more pixels for the face.
 */
export function zoomCrop(f: Face, W: number, H: number): { rect: Box; aspect: string } {
  const s = f.size;
  const c = headCenter(f);
  const [label, r] = nearestAspect(3 / 4);
  let h = Math.min(H, 6 * s);
  let w = Math.min(W, h * r);
  h = w / r;
  if (h > H) {
    h = H;
    w = h * r;
  }
  const x = Math.round(clamp(c.x - w / 2, 0, W - w));
  const y = Math.round(clamp(c.y - h * 0.3, 0, H - h));
  return { rect: { x, y, w: Math.floor(w), h: Math.floor(h) }, aspect: label };
}

/** Should the head be zoomed in on? Faces smaller than ~12% of the photo's short side lose detail at the model's size. */
export function smallFace(f: Face, W: number, H: number): boolean {
  return f.size < 0.12 * Math.min(W, H);
}

/**
 * The face photo for the model: a tight head crop — the head with its hair, the neck and the top of the shoulders
 * (≈2.6 × 3.1 face sizes), like the author's references (a head portrait). A wider photo lets the other body and the
 * framing leak into the result (wrong head size). When the hair (`hair`, photo coordinates) reaches further — long
 * or big hair — the crop grows to keep the whole hairstyle, up to ≈3.6 × 4.6 face sizes.
 */
export function headCrop(f: Face, W: number, H: number, hair?: Box | null): Box {
  const s = f.size;
  const c = headCenter(f);
  let x0 = c.x - 1.3 * s;
  let x1 = c.x + 1.3 * s;
  let y0 = c.y - 1.15 * s;
  let y1 = y0 + 3.1 * s;
  if (hair) {
    x0 = Math.min(x0, Math.max(hair.x - 0.1 * s, c.x - 1.8 * s));
    x1 = Math.max(x1, Math.min(hair.x + hair.w + 0.1 * s, c.x + 1.8 * s));
    y0 = Math.min(y0, Math.max(hair.y - 0.1 * s, c.y - 1.5 * s));
    y1 = Math.max(y1, Math.min(hair.y + hair.h + 0.15 * s, c.y + 3.1 * s));
  }
  const w = Math.min(W, x1 - x0);
  const h = Math.min(H, y1 - y0);
  const x = clamp(x0, 0, W - w);
  const y = clamp(y0, 0, H - h);
  return { x: Math.floor(x), y: Math.floor(y), w: Math.floor(w), h: Math.floor(h) };
}

const TIER_MP: Record<Resolution, number> = { '1k': 1.05e6, '1.5k': 2.3e6, '2k': 4.1e6 };

/** Size a crop is sent at: no larger than the output tier, short side at least 512, long side at most 3072. */
export function inputSize(w: number, h: number, tier: Resolution): { w: number; h: number } {
  let k = Math.min(1, Math.sqrt(TIER_MP[tier] / (w * h)));
  k = Math.max(k, 512 / Math.min(w, h));
  k = Math.min(k, 3072 / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
