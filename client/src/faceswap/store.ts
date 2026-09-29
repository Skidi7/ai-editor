/// <reference types="vite/client" />
import { create } from 'zustand';
import { ApiError, apiHealth, apiNormalize, apiRun, friendly, type FaceSwapInfo } from './api';
import { headCrop, inputSize, smallFace, wholeCrop, zoomCrop, type Resolution } from './geometry';
import { describeHair, findHair, findPeople, hairBounds, hairPrompt, peopleBlobs, peopleMask, preloadHair, type Anchor, type HairLook, type HairMap } from './hair';
import { headZone, stitch, zoneFrom } from './stitch';
import { findFaces, preloadVision, type Box, type Face } from './vision';

export type Zoom = 'auto' | 'on' | 'off';

export interface Settings {
  /** head = BFS Head Swap V1.1 (the head with its hair); body = BFS Body Swap V1.0 (the whole person). */
  mode: 'head' | 'body';
  /** Body Swap: how many people the scene has — found automatically (faces, else person areas) or set by hand. */
  people: 'auto' | 'one' | 'two';
  quality: Resolution;
  variants: number;
  /** LoRA strength: higher = closer likeness (the author suggests 1.2–1.3 when the likeness is weak). */
  strength: number;
  zoom: Zoom;
  /** Empty = random. */
  seed: string;
  /** Extra words after the trigger prompt (e.g. the expression). */
  extra: string;
  /**
   * How the prompt names the pictures. WaveSpeed binds its images to "<Picture 1>"… (its API: "Refer to references as
   * <Picture 1> through <Picture 10>") — the author's "<image1>" is ComfyUI's placeholder for the same thing and is
   * plain text on WaveSpeed.
   */
  tokens: 'image' | 'picture';
  /** BFS LoRA version: v1.1 sharper skin (recommended), v1.1-alt stronger expression, v1 the original (softest). */
  version: 'v1.1' | 'v1.1-alt' | 'v1';
  /** Tell the model the new hairstyle (and to drop a longer old one) in words, from the hair masks. */
  hairPrompt: boolean;
  /**
   * Body Swap: first turn the person's photo into the trained reference format (full body, facing the camera, arms
   * down, plain light background) with the author's plain Qwen 2.1 pass — a separate generation, off by default.
   */
  bodyNormalize: boolean;
}

export interface Photo {
  canvas: HTMLCanvasElement;
  thumb: string;
  faces: Face[];
  selected: number;
  status: 'detecting' | 'ready' | 'noface' | 'error';
  error?: string;
  /** The selected person's hairstyle in words (null = no hair found). */
  look?: HairLook | null;
}

export interface HeadPhoto extends Photo {
  /** What the model gets: head and shoulders, or the whole photo. */
  crop: Box;
  preview: string;
  /**
   * Body Swap reference as sent: the photo itself scaled to ~0.59 MP (the author's workflow keeps its background — its
   * BiRefNet node is bypassed), or its normalised full-body version. `fullBody` = the photo looks full-length.
   */
  body?: { preview: string; fullBody: boolean; normalized: boolean };
}

export interface Result {
  id: string;
  status: 'running' | 'done' | 'error';
  label: string;
  seed?: number;
  /** Final full picture (object URL) and the compared pair (the zoomed region, or the whole frame). */
  url?: string;
  before?: string;
  after?: string;
  zoomed?: boolean;
  /** New face size / original face size in the frame; null = no face found in the result. */
  ratio?: number | null;
  cost?: number;
  error?: string;
  mock?: boolean;
}

/** PNG of each finished result for the download (kept out of the state). */
const pngs = new Map<string, Blob | string>();

/** Body Swap references (JPEG data URLs) per face photo: the photo as is, and its normalised version. */
const bodyData = new WeakMap<HTMLCanvasElement, { plain: string; normalized?: string }>();

/** ~0.59 MP (768 × 768 of area), never scaled up — the author's measured best size for the reference. */
const REF_PIXELS = 0.59e6;

/** The Body Swap reference of a person photo as is: the photo scaled to ~0.59 MP (made once per photo). */
function plainRef(p: HeadPhoto): { plain: string; normalized?: string } {
  let refs = bodyData.get(p.canvas);
  if (!refs) {
    const W = p.canvas.width;
    const H = p.canvas.height;
    const k = Math.min(1, Math.sqrt(REF_PIXELS / (W * H)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * k));
    c.height = Math.max(1, Math.round(H * k));
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(p.canvas, 0, 0, c.width, c.height);
    refs = { plain: c.toDataURL('image/jpeg', 0.93) };
    c.width = 0;
    bodyData.set(p.canvas, refs);
  }
  return refs;
}

/**
 * Body Swap people to replace, in scene order: with two people in the scene the left one gets `head` and the right
 * one `head2` (either may be missing); with one person, `head`.
 */
function bodySlots(s: { head: HeadPhoto | null; head2: HeadPhoto | null; pair(): [Anchor, Anchor] | null }): Array<{ photo: HeadPhoto; side: number }> {
  const pair = s.pair();
  if (!pair) return s.head ? [{ photo: s.head, side: -1 }] : [];
  const out: Array<{ photo: HeadPhoto; side: number }> = [];
  if (s.head) out.push({ photo: s.head, side: 0 });
  if (s.head2) out.push({ photo: s.head2, side: 1 });
  return out;
}

/** People masks per scene photo (made once). */
const peopleCache = new WeakMap<HTMLCanvasElement, Promise<Awaited<ReturnType<typeof findPeople>>>>();
function peopleOf(c: HTMLCanvasElement) {
  let job = peopleCache.get(c);
  if (!job) {
    job = findPeople(c).catch(() => null);
    peopleCache.set(c, job);
  }
  return job;
}

/** Hair maps per photo and face (made once, reused by every run). */
const hairCache = new WeakMap<HTMLCanvasElement, Map<number, Promise<HairMap | null>>>();

function hairOf(c: HTMLCanvasElement, faces: Face[], i: number): Promise<HairMap | null> {
  let byFace = hairCache.get(c);
  if (!byFace) hairCache.set(c, (byFace = new Map()));
  let job = byFace.get(i);
  if (!job) {
    job = faces[i] ? findHair(c, faces[i]) : Promise.resolve(null);
    byFace.set(i, job);
    job.catch(() => byFace.delete(i));
  }
  return job;
}

interface State {
  info: FaceSwapInfo | null;
  checked: boolean;
  head: HeadPhoto | null;
  /** Body Swap of a couple: the person for the right one (`head` is then the left one). */
  head2: HeadPhoto | null;
  /** The scene's separate person areas (for couples where a face is not found). */
  scenePeople: Anchor[] | null;
  target: Photo | null;
  settings: Settings;
  results: Result[];
  selected: string | null;
  view: 'edit' | 'result';
  running: boolean;
  spent: number;
  lastPrompt: string | null;
  error: string | null;

  init(): Promise<void>;
  setHead(file: File): Promise<void>;
  setHead2(file: File): Promise<void>;
  clearHead2(): void;
  /** Two people in the scene (Body Swap): where the left and the right one are (null = one person). */
  pair(): [Anchor, Anchor] | null;
  pickHeadFace(i: number): void;
  setTarget(file: File): Promise<void>;
  pickTargetFace(i: number): void;
  setSettings(p: Partial<Settings>): void;
  plan(): { rect: Box; aspect: string; zoomed: boolean } | null;
  cost(): { each: number; total: number };
  /** The Body Swap references of the person photos (once per photo; normalised when that is on and done). */
  prepareBody(): Promise<void>;
  run(): Promise<void>;
  select(id: string): void;
  setView(v: 'edit' | 'result'): void;
  remove(id: string): void;
  download(id: string): Promise<void>;
  setError(e: string | null): void;
}

const MAX_SIDE = 4096;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  return g;
}

function toUrl(c: HTMLCanvasElement, type = 'image/jpeg', q = 0.92): Promise<string> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('Не удалось сохранить картинку'))), type, q));
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось сохранить картинку'))), 'image/png'));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось загрузить результат'));
    img.src = url;
  });
}

/** A file → working canvas (EXIF orientation applied, transparency on white, long side ≤ 4096) + thumbnail. */
async function loadPhoto(file: File): Promise<{ canvas: HTMLCanvasElement; thumb: string }> {
  if (!file.type.startsWith('image/')) throw new Error('Нужна картинка: JPG, PNG или WebP');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Не удалось прочитать изображение. Подойдут JPG, PNG или WebP.');
  }
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = canvas(bmp.width * k, bmp.height * k);
  const g = ctx(c);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  if (Math.min(c.width, c.height) < 256) throw new Error('Изображение слишком маленькое: нужно хотя бы 256 px по короткой стороне');
  const tk = 240 / Math.max(c.width, c.height);
  const t = canvas(c.width * tk, c.height * tk);
  ctx(t).drawImage(c, 0, 0, t.width, t.height);
  return { canvas: c, thumb: t.toDataURL('image/jpeg', 0.85) };
}

/** A region of a canvas at a given size. */
function region(src: HTMLCanvasElement, r: Box, w: number, h: number): HTMLCanvasElement {
  const c = canvas(w, h);
  ctx(c).drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c;
}

/**
 * Puts a zoomed-in answer back into the photo: its colours matched to the original on a band along the region's
 * edges (Qwen shifts the colours of the whole picture a little), and faded into the photo over the edges that lie
 * inside it — the head itself is far from them.
 */
function pasteBack(photo: HTMLCanvasElement, rect: Box, answer: CanvasImageSource): HTMLCanvasElement {
  const { w, h } = { w: rect.w, h: rect.h };
  const orig = ctx(region(photo, rect, w, h)).getImageData(0, 0, w, h).data;
  const ansC = canvas(w, h);
  const ag = ctx(ansC);
  ag.drawImage(answer, 0, 0, w, h);
  const ansImg = ag.getImageData(0, 0, w, h);
  const ans = ansImg.data;
  const band = Math.max(8, Math.round(0.08 * Math.min(w, h)));
  // Per-channel mean / spread on the band → gain and offset.
  const stats = [0, 1, 2].map(() => ({ so: 0, sa: 0, qo: 0, qa: 0, n: 0 }));
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (Math.min(x, y, w - 1 - x, h - 1 - y) > band) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const st = stats[c];
        st.so += orig[i + c];
        st.sa += ans[i + c];
        st.qo += orig[i + c] ** 2;
        st.qa += ans[i + c] ** 2;
        st.n++;
      }
    }
  }
  const fix = stats.map((st) => {
    const mo = st.so / st.n;
    const ma = st.sa / st.n;
    const so = Math.sqrt(Math.max(1, st.qo / st.n - mo * mo));
    const sa = Math.sqrt(Math.max(1, st.qa / st.n - ma * ma));
    const gain = Math.min(1.25, Math.max(0.8, so / sa));
    return { gain, offset: Math.min(40, Math.max(-40, mo - gain * ma)) };
  });
  const W = photo.width;
  const H = photo.height;
  const fw = Math.max(8, 0.06 * Math.min(w, h));
  const L = rect.x > 0;
  const T = rect.y > 0;
  const R = rect.x + rect.w < W - 1;
  const B = rect.y + rect.h < H - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let d = Infinity;
      if (L) d = Math.min(d, x);
      if (T) d = Math.min(d, y);
      if (R) d = Math.min(d, w - 1 - x);
      if (B) d = Math.min(d, h - 1 - y);
      const t = d === Infinity ? 1 : Math.min(1, d / fw);
      const a = t * t * (3 - 2 * t);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) ans[i + c] = orig[i + c] + (ans[i + c] * fix[c].gain + fix[c].offset - orig[i + c]) * a;
    }
  }
  ag.putImageData(ansImg, 0, 0);
  const out = canvas(W, H);
  const og = ctx(out);
  og.drawImage(photo, 0, 0);
  og.drawImage(ansC, rect.x, rect.y);
  return out;
}

export const useFaceSwap = create<State>((set, get) => {
  async function detect(c: HTMLCanvasElement): Promise<{ faces: Face[]; status: Photo['status']; error?: string }> {
    try {
      const faces = await findFaces(c);
      return { faces, status: faces.length ? 'ready' : 'noface' };
    } catch (e) {
      return { faces: [], status: 'error', error: (e as Error).message };
    }
  }

  /** The head crop of the face photo (the whole hairstyle kept when the hair was found) and its preview. */
  async function headPreview(p: Photo, selected: number): Promise<{ crop: Box; preview: string; look: HairLook | null }> {
    const W = p.canvas.width;
    const H = p.canvas.height;
    const f = p.faces[selected];
    const hair = f ? await hairOf(p.canvas, p.faces, selected).catch(() => null) : null;
    const crop = f ? headCrop(f, W, H, hair && hairBounds(hair)) : { x: 0, y: 0, w: W, h: H };
    const k = Math.min(1, 1536 / Math.max(crop.w, crop.h));
    const look = f && hair ? describeHair(p.canvas, f, hair) : null;
    return { crop, preview: region(p.canvas, crop, crop.w * k, crop.h * k).toDataURL('image/jpeg', 0.92), look };
  }

  /** The target's hair map (for the paste-back mask) and its hairstyle in words, for the selected face. */
  async function targetLook(c: HTMLCanvasElement, faces: Face[], i: number) {
    const map = faces[i] ? await hairOf(c, faces, i).catch(() => null) : null;
    const look = map ? describeHair(c, faces[i], map) : null;
    const t = get().target;
    if (t?.canvas === c && t.selected === i) set({ target: { ...t, look } });
  }

  return {
    info: null,
    checked: false,
    head: null,
    target: null,
    head2: null,
    scenePeople: null,
    settings: { mode: 'head', people: 'auto', quality: '2k', variants: 1, strength: 1, zoom: 'auto', seed: '', extra: '', tokens: 'picture', version: 'v1.1', hairPrompt: true, bodyNormalize: false },
    results: [],
    selected: null,
    view: 'edit',
    running: false,
    spent: 0,
    lastPrompt: null,
    error: null,

    async init() {
      preloadVision();
      preloadHair();
      set({ info: await apiHealth(), checked: true });
    },

    async setHead(file) {
      try {
        const { canvas: c, thumb } = await loadPhoto(file);
        const base: Photo = { canvas: c, thumb, faces: [], selected: 0, status: 'detecting' };
        set({ head: { ...base, crop: { x: 0, y: 0, w: c.width, h: c.height }, preview: thumb } });
        const found = await detect(c);
        if (get().head?.canvas !== c) return;
        const photo: Photo = { ...base, ...found };
        const hp = await headPreview(photo, 0);
        if (get().head?.canvas !== c) return;
        set({ head: { ...photo, ...hp } });
        if (found.status === 'noface' && get().settings.mode === 'head') set({ error: 'На фото лица не нашлось лица — модель получит фото целиком.' });
        if (get().settings.mode === 'body') void get().prepareBody();
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    async setHead2(file) {
      try {
        const { canvas: c, thumb } = await loadPhoto(file);
        const base: Photo = { canvas: c, thumb, faces: [], selected: 0, status: 'detecting' };
        set({ head2: { ...base, crop: { x: 0, y: 0, w: c.width, h: c.height }, preview: thumb } });
        const found = await detect(c);
        if (get().head2?.canvas !== c) return;
        set({ head2: { ...base, ...found, crop: { x: 0, y: 0, w: c.width, h: c.height }, preview: thumb } });
        void get().prepareBody();
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    clearHead2() {
      set({ head2: null });
    },

    pair() {
      const { target: t, settings, scenePeople } = get();
      if (!t || settings.people === 'one') return null;
      const sorted = (a: Anchor, b: Anchor): [Anchor, Anchor] => (a.cx <= b.cx ? [a, b] : [b, a]);
      // 1. Two faces (findFaces returns the biggest first).
      if (t.faces.length >= 2) {
        const [a, b] = t.faces.slice(0, 2).map((g) => ({ cx: g.center.x, cy: g.center.y, top: g.top.y, size: g.size }));
        return sorted(a, b);
      }
      // 2. Two separate person areas (a face turned away, too small, or covered).
      if (scenePeople && scenePeople.length >= 2) return sorted(scenePeople[0], scenePeople[1]);
      // 3. Set by hand: two people standing close (one area) — its left and right parts.
      if (settings.people === 'two') {
        const W = t.canvas.width;
        const H = t.canvas.height;
        const one = scenePeople?.[0] as (Anchor & { x0?: number; x1?: number }) | undefined;
        const x0 = one?.x0 ?? 0;
        const x1 = one?.x1 ?? W;
        const top = one?.top ?? 0;
        const size = one?.size ?? H / 7;
        return [
          { cx: x0 + 0.27 * (x1 - x0), cy: top + size, top, size },
          { cx: x0 + 0.73 * (x1 - x0), cy: top + size, top, size },
        ];
      }
      return null;
    },

    async pickHeadFace(i) {
      const h = get().head;
      if (!h || !h.faces[i]) return;
      set({ head: { ...h, selected: i } });
      const hp = await headPreview(h, i);
      const now = get().head;
      if (now?.canvas === h.canvas && now.selected === i) set({ head: { ...now, ...hp } });
    },

    async setTarget(file) {
      try {
        const { canvas: c, thumb } = await loadPhoto(file);
        set({ target: { canvas: c, thumb, faces: [], selected: 0, status: 'detecting' }, view: 'edit' });
        const found = await detect(c);
        if (get().target?.canvas !== c) return;
        set({ target: { canvas: c, thumb, selected: 0, ...found }, scenePeople: null });
        // The hair map for the paste-back mask and the hairstyle in words, ahead of the run.
        if (found.faces.length) void targetLook(c, found.faces, 0);
        // Separate people (a couple is found even when a face is not).
        void peopleOf(c).then((m) => {
          if (m && get().target?.canvas === c) set({ scenePeople: peopleBlobs(m) });
        });
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    pickTargetFace(i) {
      const t = get().target;
      if (!t || !t.faces[i]) return;
      set({ target: { ...t, selected: i, look: undefined } });
      void targetLook(t.canvas, t.faces, i);
    },

    setSettings(p) {
      const was = get().settings.mode;
      // The author's defaults per LoRA: the head at 2K; the body scene at ~2 MP (1.5K), strength 1.0 for both.
      const modeDefaults: Partial<Settings> = p.mode && p.mode !== was ? { quality: p.mode === 'body' ? '1.5k' : '2k', strength: 1 } : {};
      set({ settings: { ...get().settings, ...modeDefaults, ...p } });
      if (p.mode === 'body' || 'bodyNormalize' in p) void get().prepareBody();
    },

    async prepareBody() {
      for (const slot of ['head', 'head2'] as const) {
        const h = get()[slot];
        if (!h || h.status === 'detecting') continue;
        const refs = plainRef(h);
        const useNormalized = get().settings.bodyNormalize && !!refs.normalized;
        const f = h.faces[h.selected];
        // Full length ≈ the face is at most ~1/5.5 of the photo's height.
        const fullBody = !f || h.canvas.height / f.size >= 5.5;
        const now = get()[slot];
        if (now?.canvas === h.canvas) set({ [slot]: { ...now, body: { preview: useNormalized ? refs.normalized! : refs.plain, fullBody, normalized: useNormalized } } });
      }
    },

    plan() {
      const { target, settings } = get();
      if (!target) return null;
      const W = target.canvas.width;
      const H = target.canvas.height;
      // Body Swap: the whole scene (the author scales it to ~2 MP, no crops).
      if (settings.mode === 'body') return { ...wholeCrop(W, H), zoomed: false };
      const f = target.faces[target.selected];
      const zoomed = !!f && (settings.zoom === 'on' || (settings.zoom === 'auto' && smallFace(f, W, H)));
      const c = zoomed && f ? zoomCrop(f, W, H) : wholeCrop(W, H);
      return { ...c, zoomed };
    },

    cost() {
      const { info, settings } = get();
      const refs = get().settings.mode === 'body' ? bodySlots(get()) : [];
      const two = refs.length === 2;
      const each = two
        ? info?.pricesTwo?.[settings.quality] ?? { '1k': 0.055, '1.5k': 0.095, '2k': 0.165 }[settings.quality]
        : info?.prices[settings.quality] ?? { '1k': 0.045, '1.5k': 0.08, '2k': 0.145 }[settings.quality];
      // The normalisation pass is paid once per person photo.
      const toNormalize = settings.bodyNormalize ? refs.filter((r) => !bodyData.get(r.photo.canvas)?.normalized).length : 0;
      const normalize = toNormalize * (info?.normalizePrice ?? 0.03);
      return { each, total: Math.round((each * settings.variants + normalize) * 10000) / 10000 };
    },

    async run() {
      const { head, target, settings, running } = get();
      if (running) return;
      const body = settings.mode === 'body';
      if (!target || target.status === 'detecting') return set({ error: body ? 'Загрузите сцену' : 'Загрузите фото, где меняем голову' });
      const slots = body ? bodySlots(get()) : [];
      if (body ? !slots.length || slots.some((r) => r.photo.status === 'detecting') : !head || head.status === 'detecting') {
        return set({ error: body ? 'Загрузите фото человека' : 'Загрузите фото лица' });
      }
      if (!head && !body) return;
      const plan = get().plan()!;
      const { each } = get().cost();
      const size = inputSize(plan.rect.w, plan.rect.h, settings.quality);
      const input = region(target.canvas, plan.rect, size.w, size.h);
      const photo = target.canvas;
      // The original face in the input's coordinates, for the size check.
      const f = target.faces[target.selected];
      const k = size.w / plan.rect.w;
      const ref = f ? { x: (f.center.x - plan.rect.x) * k, y: (f.center.y - plan.rect.y) * k, size: f.size * k } : null;

      const batch = uid();
      const label = body
        ? `${slots.length === 2 ? 'Двое' : 'Тело'} · ${settings.quality.toUpperCase()}`
        : `${settings.version} · ${settings.quality.toUpperCase()}${plan.zoomed ? ' · приближено' : ''}`;
      const cards: Result[] = Array.from({ length: settings.variants }, (_, i) => ({ id: `${batch}-${i}`, status: 'running', label: `${label} · вариант ${i + 1}` }));
      set({ running: true, results: [...cards, ...get().results], selected: cards[0].id, view: 'result' });
      const patch = (id: string, p: Partial<Result>) => set({ results: get().results.map((r) => (r.id === id ? { ...r, ...p } : r)) });
      try {
        // The hairstyle in words after the trigger: the new one from the face photo and, when the old one was longer,
        // that it goes — the model otherwise tends to keep long hair it sees on the shoulders.
        let hairText = '';
        if (!body && head && settings.hairPrompt) {
          const hf = head.faces[head.selected];
          const newLook = head.look !== undefined ? head.look : hf ? await hairOf(head.canvas, head.faces, head.selected).then((m) => (m ? describeHair(head.canvas, hf, m) : null)).catch(() => null) : null;
          const oldLook = f ? await hairOf(photo, target.faces, target.selected).then((m) => (m ? describeHair(photo, f, m) : null)).catch(() => null) : null;
          if (newLook) hairText = hairPrompt(newLook, oldLook, settings.tokens);
        }
        const extra = [hairText, settings.extra.trim()].filter(Boolean).join(' ');
        // Body Swap, the author's optional first pass: each person as a full-body, front-facing reference.
        let normalizeCost = 0;
        if (body && settings.bodyNormalize) {
          for (const slot of slots) {
            const refs = plainRef(slot.photo);
            if (refs.normalized) continue;
            const hp = slot.photo.canvas;
            const k = Math.min(1, Math.sqrt(1.5e6 / (hp.width * hp.height)));
            const src = region(hp, { x: 0, y: 0, w: hp.width, h: hp.height }, hp.width * k, hp.height * k);
            const r = await apiNormalize({ person: src.toDataURL('image/jpeg', 0.93), tokens: settings.tokens });
            src.width = 0;
            const cost = r.mock ? 0 : r.cost;
            normalizeCost += cost;
            set({ spent: Math.round((get().spent + cost) * 10000) / 10000 });
            const img: CanvasImageSource = r.mock ? hp : await loadImage(r.url);
            const iw = r.mock ? hp.width : (img as HTMLImageElement).naturalWidth;
            const ih = r.mock ? hp.height : (img as HTMLImageElement).naturalHeight;
            const nk = Math.min(1, Math.sqrt(REF_PIXELS / (iw * ih)));
            const c = canvas(iw * nk, ih * nk);
            ctx(c).drawImage(img, 0, 0, c.width, c.height);
            refs.normalized = c.toDataURL('image/jpeg', 0.93);
            c.width = 0;
          }
          await get().prepareBody();
        }
        const refOf = (p: HeadPhoto) => {
          const refs = plainRef(p);
          return settings.bodyNormalize && refs.normalized ? refs.normalized : refs.plain;
        };
        // Body mode: the references in scene order (left, right).
        const references = body ? slots.map((r) => refOf(r.photo)) : [head!.preview];
        const seed = settings.seed.trim() ? Number(settings.seed) : undefined;
        const res = await apiRun({
          mode: body ? 'body' : 'head',
          target: input.toDataURL('image/jpeg', 0.93),
          head: references[0],
          head2: references[1],
          resolution: settings.quality,
          aspect: plan.aspect,
          variants: settings.variants,
          seed: seed !== undefined && Number.isFinite(seed) ? seed : undefined,
          strength: settings.strength,
          tokens: settings.tokens,
          version: settings.version,
          extra: extra || undefined,
        });
        set({ lastPrompt: res.prompt, spent: Math.round((get().spent + res.cost) * 10000) / 10000 });
        for (let i = 0; i < cards.length; i++) {
          const id = cards[i].id;
          const out = res.results[i];
          if (!out?.url) {
            patch(id, { status: 'error', error: friendly(out?.error || 'Нет результата'), seed: out?.seed });
            continue;
          }
          try {
            const answer: CanvasImageSource = res.mock ? input : await loadImage(out.url);
            const aw = res.mock ? input.width : (answer as HTMLImageElement).naturalWidth;
            const ah = res.mock ? input.height : (answer as HTMLImageElement).naturalHeight;
            // Compared pair: the region before / the answer, at the answer's size.
            const after = canvas(aw, ah);
            ctx(after).drawImage(answer, 0, 0, aw, ah);
            const before = region(photo, plan.rect, aw, ah);
            // Head size in the result against the original (both in the same frame).
            let ratio: number | null = null;
            let best: Face | null = null;
            if (ref && !body) {
              const faces = await findFaces(after, { tiles: plan.zoomed ? false : true });
              const s = aw / size.w;
              let bestD = Infinity;
              for (const g of faces) {
                const d = Math.hypot(g.center.x - ref.x * s, g.center.y - ref.y * s);
                if (d < bestD && d < 3 * ref.size * s) {
                  bestD = d;
                  best = g;
                }
              }
              ratio = best ? best.size / (ref.size * s) : null;
            }
            // Back into the photo only through the mask of the head: the old and the new hair, both faces, the neck
            // (like the BFS author's InpaintCrop / InpaintStitch). Everything else keeps its own pixels at full
            // resolution — no smeared clothes, no colour shift of the whole frame.
            // (Body Swap changes the whole person: its answer is kept as is, like in the author's workflow.)
            const oldMap = !body && f ? await hairOf(photo, target.faces, target.selected).catch(() => null) : null;
            const newMap = !body && best ? await findHair(after, best).catch(() => null) : null;
            let zone = body ? null : headZone(aw, ah, plan.rect, { map: oldMap, face: f ?? null }, { map: newMap, face: best });
            // Body Swap in a couple photo: only the replaced people go back (the LoRA re-renders everyone it sees),
            // through their masks in the photo and in the answer; the rest keeps its own pixels.
            const pair = body ? get().pair() : null;
            if (pair) {
              const anchorsPhoto: Anchor[] = pair;
              const ka = aw / plan.rect.w;
              const anchorsAns: Anchor[] = anchorsPhoto.map((a) => ({ cx: (a.cx - plan.rect.x) * ka, cy: (a.cy - plan.rect.y) * ka, top: (a.top - plan.rect.y) * ka, size: a.size * ka }));
              const which = slots.map((r) => r.side);
              const [oldPeople, newPeople] = await Promise.all([peopleOf(photo), findPeople(after).catch(() => null)]);
              const masks: Uint8Array[] = [];
              if (oldPeople) masks.push(peopleMask(oldPeople, anchorsPhoto, which, plan.rect, aw, ah));
              if (newPeople) masks.push(peopleMask(newPeople, anchorsAns, which, { x: 0, y: 0, w: aw, h: ah }, aw, ah));
              zone = zoneFrom(masks, aw, ah, Math.max(...anchorsAns.map((a) => a.size)));
            }
            let final: HTMLCanvasElement;
            let shown = after;
            if (zone) {
              final = stitch(photo, plan.rect, after, aw, ah, zone);
              shown = region(final, plan.rect, aw, ah);
              pngs.set(id, await toBlob(final));
            } else if (plan.zoomed) {
              final = pasteBack(photo, plan.rect, answer);
              pngs.set(id, await toBlob(final));
            } else {
              final = after;
              pngs.set(id, res.mock ? await toBlob(after) : out.url);
            }
            patch(id, {
              status: 'done',
              seed: out.seed,
              url: await toUrl(final, 'image/jpeg', 0.95),
              before: await toUrl(before),
              after: await toUrl(shown),
              zoomed: plan.zoomed,
              ratio: ref && !body ? ratio : undefined,
              cost: res.mock ? 0 : each + (i === 0 ? normalizeCost : 0),
              mock: res.mock,
            });
            if (final !== after) final.width = 0;
            if (shown !== after) shown.width = 0;
            before.width = 0;
            after.width = 0;
          } catch (e) {
            patch(id, { status: 'error', error: (e as Error).message, seed: out.seed });
          }
        }
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : friendly((e as Error).message);
        for (const c of cards) patch(c.id, { status: 'error', error: msg });
        set({ error: msg });
      } finally {
        set({ running: false });
      }
    },

    select(id) {
      set({ selected: id, view: 'result' });
    },

    setView(v) {
      set({ view: v });
    },

    remove(id) {
      const r = get().results.find((x) => x.id === id);
      for (const u of [r?.url, r?.before, r?.after]) if (u?.startsWith('blob:')) URL.revokeObjectURL(u);
      pngs.delete(id);
      const results = get().results.filter((x) => x.id !== id);
      set({ results, selected: get().selected === id ? results[0]?.id ?? null : get().selected, view: results.length ? get().view : 'edit' });
    },

    async download(id) {
      const p = pngs.get(id);
      if (!p) return;
      const url = typeof p === 'string' ? p : URL.createObjectURL(p);
      const a = document.createElement('a');
      a.href = url;
      a.download = `face-swap-${id}.png`;
      a.click();
      if (typeof p !== 'string') setTimeout(() => URL.revokeObjectURL(url), 5000);
    },

    setError(e) {
      set({ error: e });
    },
  };
});

// Dev builds expose the store for automated browser checks (never in production bundles).
if (import.meta.env.DEV) (window as unknown as { __faceswap: typeof useFaceSwap }).__faceswap = useFaceSwap;
