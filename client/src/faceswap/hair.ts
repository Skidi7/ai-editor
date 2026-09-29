/**
 * In-browser hair finder — free, nothing leaves the page. MediaPipe ImageSegmenter with the selfie multiclass model
 * (0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other) finds the person's hair. It gives the mask the
 * model's answer is pasted back through (the old and the new hair, see stitch.ts) and keeps the whole hairstyle
 * inside the head crop of the face photo.
 */
import { ImageSegmenter } from '@mediapipe/tasks-vision';
import { BASE, FILESET, headCenter, type Box, type Face, type Pt } from './vision';

const MODEL = 'selfie_multiclass_256x256.tflite';
const HAIR = 1;
const FACE_SKIN = 3;

let segmenter: Promise<ImageSegmenter> | null = null;

function load(): Promise<ImageSegmenter> {
  segmenter ??= ImageSegmenter.createFromOptions(FILESET, {
    baseOptions: { modelAssetPath: `${BASE}${MODEL}`, delegate: 'CPU' },
    runningMode: 'IMAGE',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  }).catch((e) => {
    segmenter = null;
    throw new Error(`Не удалось загрузить модель поиска волос: ${(e as Error).message}`);
  });
  return segmenter;
}

export function preloadHair() {
  void load().catch(() => undefined);
}

/** One person's hair: confidence 0..1 on a w × h grid laid over `box` (photo coordinates). */
export interface HairMap {
  box: Box;
  w: number;
  h: number;
  /** Hair connected to this person's head. */
  hair: Float32Array;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function sample(a: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = clamp(x, 0, w - 1);
  const cy = clamp(y, 0, h - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const top = a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx;
  const bot = a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

/** Square dilation of a 0/1 map by `d` pixels (two running-window passes). */
export function dilate(src: Uint8Array, w: number, h: number, d: number): Uint8Array {
  if (d < 1) return src;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    const row = y * w;
    for (let x = 0; x < Math.min(w, d); x++) run += src[row + x];
    for (let x = 0; x < w; x++) {
      if (x + d < w) run += src[row + x + d];
      if (x - d - 1 >= 0) run -= src[row + x - d - 1];
      tmp[row + x] = run > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < Math.min(h, d); y++) run += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + d < h) run += tmp[(y + d) * w + x];
      if (y - d - 1 >= 0) run -= tmp[(y - d - 1) * w + x];
      out[y * w + x] = run > 0 ? 1 : 0;
    }
  }
  return out;
}

/** Calls `span(row, x0, x1)` for the pixel runs inside a polygon (even-odd rule, pixel centres). */
export function polygonSpans(poly: Pt[], w: number, h: number, span: (row: number, x0: number, x1: number) => void) {
  if (poly.length < 3) return;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const p of poly) {
    ymin = Math.min(ymin, p.y);
    ymax = Math.max(ymax, p.y);
  }
  const xs: number[] = [];
  for (let y = Math.max(0, Math.floor(ymin)); y < Math.min(h, Math.ceil(ymax)); y++) {
    const py = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if ((a.y <= py && b.y > py) || (b.y <= py && a.y > py)) xs.push(a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      if (x1 >= x0) span(y, x0, x1);
    }
  }
}

/** Confidences of the given classes for the photo region `r` drawn at w × h. */
function segment(sg: ImageSegmenter, src: HTMLCanvasElement, r: Box, w: number, h: number, classes: number[]): Array<Float32Array | null> {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, w, h);
  const res = sg.segment(cv);
  const out = classes.map((n) => {
    const m = res.confidenceMasks?.[n];
    if (!m) return null;
    const a = m.getAsFloat32Array();
    if (m.width === w && m.height === h) return a.slice();
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) o[y * w + x] = a[Math.floor((y * m.height) / h) * m.width + Math.floor((x * m.width) / w)];
    }
    return o;
  });
  res.close();
  cv.width = 0;
  return out;
}

/** Finds the hair of the person with face `f` in `src`; null when there is none (or the face is not a face). */
export async function findHair(src: HTMLCanvasElement, f: Face): Promise<HairMap | null> {
  const sg = await load();
  const s = f.size;
  const c = headCenter(f);
  // Head, shoulders and long hair down to the waist.
  const x0 = clamp(c.x - 2.6 * s, 0, src.width);
  const x1 = clamp(c.x + 2.6 * s, 0, src.width);
  const y0 = clamp(c.y - 1.9 * s, 0, src.height);
  const y1 = clamp(c.y + 5.8 * s, 0, src.height);
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (box.w < 8 || box.h < 8) return null;
  const k = 512 / Math.max(box.w, box.h);
  const w = Math.max(8, Math.round(box.w * k));
  const h = Math.max(8, Math.round(box.h * k));
  const [all, faceSkin] = segment(sg, src, box, w, h, [HAIR, FACE_SKIN]);
  if (!all) return null;

  // A real face has face skin inside its oval: the face finder sometimes takes a blurry object for a face, and the
  // "hair" around it would be someone else's.
  if (faceSkin) {
    let n = 0;
    let sum = 0;
    const poly = f.outline.map((p) => ({ x: (p.x - box.x) * k, y: (p.y - box.y) * k }));
    polygonSpans(poly, w, h, (row, a, b) => {
      for (let x = a; x <= b; x++) {
        sum += faceSkin[row * w + x];
        n++;
      }
    });
    if (n && sum / n < 0.25) return null;
  }

  // Keep the hair connected to this head: flood fill from the sure hair around the head centre (> 0.5) through
  // anything hair-like (> 0.25), so thin loose strands at the ends come along.
  const hx = (c.x - box.x) * k;
  const hy = (c.y - box.y) * k;
  const seedR = 1.2 * s * k;
  const keep = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let y = Math.max(0, Math.floor(hy - seedR)); y < Math.min(h, Math.ceil(hy + seedR)); y++) {
    for (let x = Math.max(0, Math.floor(hx - seedR)); x < Math.min(w, Math.ceil(hx + seedR)); x++) {
      const i = y * w + x;
      if (all[i] > 0.5 && Math.hypot(x - hx, y - hy) <= seedR) {
        keep[i] = 1;
        stack.push(i);
      }
    }
  }
  if (!stack.length) return null;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (keep[j] || all[j] <= 0.25) continue;
        keep[j] = 1;
        stack.push(j);
      }
    }
  }
  // The soft edge of the kept hair stays with it (so the mask covers the strands' fringe).
  const hair = new Float32Array(w * h);
  const near = dilate(keep, w, h, 2);
  for (let i = 0; i < hair.length; i++) {
    if (keep[i]) hair[i] = Math.max(all[i], 0.51);
    else if (near[i] && all[i] >= 0.1) hair[i] = 0.51;
  }
  return { box, w, h, hair };
}

/** Bounding box of the person's hair in photo coordinates. */
export function hairBounds(m: HairMap): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (m.hair[y * m.w + x] <= 0.5) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  if (x0 === Infinity) return null;
  const sx = m.box.w / m.w;
  const sy = m.box.h / m.h;
  return { x: m.box.x + x0 * sx, y: m.box.y + y0 * sy, w: (x1 - x0) * sx, h: (y1 - y0) * sy };
}

/** The person's hair (> 0.5) for the photo region `rect` drawn at outW × outH. */
export function hairRaw(m: HairMap, rect: Box, outW: number, outH: number): Uint8Array {
  const out = new Uint8Array(outW * outH);
  const sx = rect.w / outW;
  const sy = rect.h / outH;
  const gx = m.w / m.box.w;
  const gy = m.h / m.box.h;
  const ox0 = clamp(Math.floor((m.box.x - rect.x) / sx), 0, outW);
  const ox1 = clamp(Math.ceil((m.box.x + m.box.w - rect.x) / sx), 0, outW);
  const oy0 = clamp(Math.floor((m.box.y - rect.y) / sy), 0, outH);
  const oy1 = clamp(Math.ceil((m.box.y + m.box.h - rect.y) / sy), 0, outH);
  for (let oy = oy0; oy < oy1; oy++) {
    const my = (rect.y + (oy + 0.5) * sy - m.box.y) * gy - 0.5;
    for (let ox = ox0; ox < ox1; ox++) {
      if (sample(m.hair, m.w, m.h, (rect.x + (ox + 0.5) * sx - m.box.x) * gx - 0.5, my) > 0.5) out[oy * outW + ox] = 1;
    }
  }
  return out;
}

/** A hairstyle in words for the prompt (English) and the page (Russian). */
export interface HairLook {
  length: 'short' | 'chin' | 'shoulder' | 'long';
  colour: string;
  ru: string;
  /** Lit hair brightness against lit face skin (1 = as bright as the skin). */
  rel: number;
}

const LENGTH_RU: Record<HairLook['length'], string> = {
  short: 'короткие, выше подбородка',
  chin: 'каре до подбородка',
  shoulder: 'до плеч',
  long: 'длинные, ниже плеч',
};

/**
 * A hair colour name from the lit hair's RGB and its brightness relative to the lit face skin of the same photo
 * (`rel`): a dim studio shot makes blonde hair dark in absolute terms, not against the skin.
 */
function colourName(r: number, g: number, b: number, rel: number): [string, string] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d > 0) {
    const R = r / 255;
    const G = g / 255;
    const B = b / 255;
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
    if (h < 0) h += 360;
  }
  // Dyed colours first (pastel lavender is barely saturated).
  if (h >= 255 && h < 335 && s > 0.06) return l > 0.5 ? ['lavender', 'лавандовые'] : ['purple', 'фиолетовые'];
  if ((h >= 335 || h < 5) && s > 0.3) return rel > 0.7 ? ['pink', 'розовые'] : ['burgundy', 'бордовые'];
  if (h >= 180 && h < 255 && s > 0.15) return ['blue', 'синие'];
  if (h >= 75 && h < 180 && s > 0.15) return ['green', 'зелёные'];
  if (rel < 0.3) return ['black', 'чёрные'];
  if (s < 0.16 && rel > 0.85) return ['grey', 'седые'];
  if (h < 30 && s > 0.25 && rel >= 0.4) return rel > 0.6 ? ['copper red', 'рыжие'] : ['auburn', 'каштаново-рыжие'];
  if (rel < 0.45) return ['dark brown', 'тёмно-каштановые'];
  if (rel < 0.55) return ['brown', 'каштановые'];
  if (rel < 0.68) return ['light brown', 'светло-каштановые'];
  if (rel < 0.82) return ['dark blonde', 'тёмно-русые'];
  if (s < 0.2 && rel > 1.02) return ['platinum blonde', 'платиновые'];
  return ['blonde', 'светлые'];
}

/**
 * Length (where the hair ends against the chin, in face sizes) and colour (median of the sure hair) of the person's
 * hair — words for the prompt, so the model is told which hairstyle to draw and which one to drop.
 */
export function describeHair(src: HTMLCanvasElement, f: Face, m: HairMap): HairLook | null {
  const cv = document.createElement('canvas');
  cv.width = m.w;
  cv.height = m.h;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, m.box.x, m.box.y, m.box.w, m.box.h, 0, 0, m.w, m.h);
  const d = g.getImageData(0, 0, m.w, m.h).data;
  cv.width = 0;
  const px: Array<[number, number, number, number]> = [];
  let lastRow = -1;
  for (let y = 0; y < m.h; y++) {
    let n = 0;
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      if (m.hair[i] > 0.5) n++;
      if (m.hair[i] > 0.8) px.push([0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2], d[4 * i], d[4 * i + 1], d[4 * i + 2]]);
    }
    if (n >= 3) lastRow = y;
  }
  if (px.length < 30 || lastRow < 0) return null;
  // The colour people name is the lit part: the 80th–97th percentile by brightness (no shadows, no glare).
  const lit = (list: Array<[number, number, number, number]>): [number, number, number, number] => {
    list.sort((p, q) => p[0] - q[0]);
    const from = Math.floor(list.length * 0.8);
    const to = Math.max(from + 1, Math.floor(list.length * 0.97));
    const sum = [0, 0, 0, 0];
    for (let i = from; i < to; i++) for (let c = 0; c < 4; c++) sum[c] += list[i][c];
    return sum.map((v) => v / (to - from)) as [number, number, number, number];
  };
  const hairLit = lit(px);
  // Lit face skin inside the inner face oval, as the brightness reference.
  const skin: Array<[number, number, number, number]> = [];
  let fx = 0;
  let fy = 0;
  for (const p of f.outline) {
    fx += p.x;
    fy += p.y;
  }
  fx /= f.outline.length || 1;
  fy /= f.outline.length || 1;
  const gx = m.w / m.box.w;
  const gy = m.h / m.box.h;
  const inner = f.outline.map((p) => ({ x: (fx + (p.x - fx) * 0.7 - m.box.x) * gx, y: (fy + (p.y - fy) * 0.7 - m.box.y) * gy }));
  polygonSpans(inner, m.w, m.h, (row, a, b) => {
    for (let x = a; x <= b; x++) {
      const i = row * m.w + x;
      skin.push([0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2], d[4 * i], d[4 * i + 1], d[4 * i + 2]]);
    }
  });
  const skinL = skin.length >= 20 ? lit(skin)[0] : 180;
  const rel = hairLit[0] / Math.max(40, skinL);
  const [colour, colourRu] = colourName(hairLit[1], hairLit[2], hairLit[3], rel);
  // Where the hair ends against the chin, in face sizes (MediaPipe's face size ≈ mid-forehead to chin): a bob ends at
  // the jaw, shoulders are ≈ 0.4–1 below the chin, long hair lies on the chest.
  const bottom = m.box.y + ((lastRow + 1) * m.box.h) / m.h;
  const below = (bottom - f.chin.y) / f.size;
  const length: HairLook['length'] = below < 0 ? 'short' : below < 0.35 ? 'chin' : below < 1 ? 'shoulder' : 'long';
  return { length, colour, ru: `${colourRu}, ${LENGTH_RU[length]}`, rel: Math.round(rel * 100) / 100 };
}

const RANK: Record<HairLook['length'], number> = { short: 0, chin: 1, shoulder: 2, long: 3 };

/** The hairstyle part of the prompt: what to draw (from the face photo) and, when it was longer, what to drop. */
export function hairPrompt(neu: HairLook, old: HairLook | null, tokens: 'image' | 'picture'): string {
  const a = tokens === 'picture' ? '<Picture 1>' : '<image1>';
  const b = tokens === 'picture' ? '<Picture 2>' : '<image2>';
  const style = {
    short: `short ${neu.colour} hair that ends above the chin`,
    chin: `a ${neu.colour} chin-length bob that ends at the jaw`,
    shoulder: `${neu.colour} shoulder-length hair`,
    long: `long ${neu.colour} hair past the shoulders`,
  }[neu.length];
  let text = `The hairstyle is exactly the one in ${b}: ${style}.`;
  if (old && RANK[old.length] > RANK[neu.length]) {
    text +=
      ` The ${old.length === 'long' ? 'long' : 'shoulder-length'} ${old.colour} hair of ${a} is removed completely: ` +
      'no hair on the shoulders, chest, arms or back, show the skin and the clothes there.';
  } else if (old && old.colour !== neu.colour) {
    text += ` None of the ${old.colour} hair of ${a} remains.`;
  }
  return text;
}

/** People (any person, 1 − background) over a whole picture: confidence on a w × h grid laid over `box`. */
export interface PeopleMap {
  box: Box;
  w: number;
  h: number;
  person: Float32Array;
}

export async function findPeople(src: HTMLCanvasElement): Promise<PeopleMap | null> {
  const sg = await load();
  const W = src.width;
  const H = src.height;
  const k = 512 / Math.max(W, H);
  const w = Math.max(8, Math.round(W * k));
  const h = Math.max(8, Math.round(H * k));
  const [bg] = segment(sg, src, { x: 0, y: 0, w: W, h: H }, w, h, [0]);
  if (!bg) return null;
  const person = new Float32Array(w * h);
  for (let i = 0; i < person.length; i++) person[i] = 1 - bg[i];
  return { box: { x: 0, y: 0, w: W, h: H }, w, h, person };
}

/** Where a person is: the face centre, the top of the face and its size (in the frame the mask is drawn for). */
export interface Anchor {
  cx: number;
  cy: number;
  top: number;
  size: number;
}

/**
 * The pixels of the chosen people (`which`: indexes into `anchors`) for the photo region `rect` drawn at
 * outW × outH: each person pixel goes to the nearest face across (bodies hang under their faces), pixels well above
 * a face don't belong to it. Enough to tell apart two people side by side in a couple photo.
 */
export function peopleMask(m: PeopleMap, anchors: Anchor[], which: number[], rect: Box, outW: number, outH: number): Uint8Array {
  const out = new Uint8Array(outW * outH);
  if (!anchors.length || !which.length) return out;
  const sx = rect.w / outW;
  const sy = rect.h / outH;
  const gx = m.w / m.box.w;
  const gy = m.h / m.box.h;
  // Anchors in output pixels.
  const a = anchors.map((p) => ({ cx: (p.cx - rect.x) / sx, top: (p.top - rect.y) / sy, s: Math.max(1, p.size / sx) }));
  const want = new Uint8Array(a.length);
  for (const i of which) if (i >= 0 && i < a.length) want[i] = 1;
  for (let oy = 0; oy < outH; oy++) {
    const my = (rect.y + (oy + 0.5) * sy - m.box.y) * gy - 0.5;
    for (let ox = 0; ox < outW; ox++) {
      if (sample(m.person, m.w, m.h, (rect.x + (ox + 0.5) * sx - m.box.x) * gx - 0.5, my) <= 0.5) continue;
      let best = -1;
      let bestCost = Infinity;
      for (let i = 0; i < a.length; i++) {
        const above = a[i].top - 0.8 * a[i].s - oy;
        const cost = Math.abs(ox - a[i].cx) / a[i].s + (above > 0 ? (3 * above) / a[i].s : 0);
        if (cost < bestCost) {
          bestCost = cost;
          best = i;
        }
      }
      if (best >= 0 && want[best]) out[oy * outW + ox] = 1;
    }
  }
  return out;
}

/**
 * Separate people of a scene: the connected person areas (≥ `minShare` of the frame), biggest first, as anchors in
 * photo coordinates — works when a face is turned away or too small for the face finder. The anchor size is a head
 * size guess (≈ 1/7 of the area's height).
 */
export function peopleBlobs(m: PeopleMap, minShare = 0.02): Array<Anchor & { x0: number; x1: number; area: number }> {
  const { w, h } = m;
  const label = new Int32Array(w * h).fill(-1);
  const out: Array<Anchor & { x0: number; x1: number; area: number }> = [];
  const sx = m.box.w / w;
  const sy = m.box.h / h;
  for (let i0 = 0, id = 0; i0 < w * h; i0++) {
    if (m.person[i0] <= 0.5 || label[i0] >= 0) continue;
    const queue = [i0];
    label[i0] = id;
    let x0 = w;
    let x1 = -1;
    let y0 = h;
    let y1 = -1;
    let sumX = 0;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % w;
      const y = (i - x) / w;
      sumX += x;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= w * h || label[j] >= 0 || m.person[j] <= 0.5) continue;
        label[j] = id;
        queue.push(j);
      }
    }
    id++;
    if (queue.length < minShare * w * h) continue;
    const size = Math.max(4, ((y1 + 1 - y0) * sy) / 7);
    out.push({
      cx: m.box.x + (sumX / queue.length + 0.5) * sx,
      top: m.box.y + y0 * sy,
      cy: m.box.y + y0 * sy + size,
      size,
      x0: m.box.x + x0 * sx,
      x1: m.box.x + (x1 + 1) * sx,
      area: queue.length,
    });
  }
  return out.sort((a, b) => b.area - a.area);
}
