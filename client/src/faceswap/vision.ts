/**
 * In-browser face finder (MediaPipe FaceLandmarker, CPU). Runtime and model come from our server
 * (/api/faceswap/vision/*), nothing is fetched from third-party hosts at run time.
 * Used to crop the face photo to head and shoulders, to zoom in on small heads, and to check the result's head size.
 */
import { FaceLandmarker } from '@mediapipe/tasks-vision';

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Face {
  box: Box;
  center: Pt;
  top: Pt;
  chin: Pt;
  /** Forehead-to-chin and cheek-to-cheek distances; `size` = the larger one (robust to head turns). */
  height: number;
  width: number;
  size: number;
  /** Face oval (forehead, cheeks, jaw, chin) in order: part of the paste-back mask, and the face-skin check. */
  outline: Pt[];
}

export const BASE = '/api/faceswap/vision/';
export const FILESET = { wasmLoaderPath: `${BASE}vision_wasm_internal.js`, wasmBinaryPath: `${BASE}vision_wasm_internal.wasm` };

let landmarker: Promise<FaceLandmarker> | null = null;

function load(): Promise<FaceLandmarker> {
  landmarker ??= FaceLandmarker.createFromOptions(FILESET, {
    baseOptions: { modelAssetPath: `${BASE}face_landmarker.task`, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 6,
    minFaceDetectionConfidence: 0.4,
    minFacePresenceConfidence: 0.4,
  }).catch((e) => {
    landmarker = null;
    throw new Error(`Не удалось загрузить модель поиска лиц: ${(e as Error).message}`);
  });
  return landmarker;
}

export function preloadVision() {
  void load().catch(() => undefined);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** MediaPipe face mesh indices of the face oval, clockwise from the top of the forehead. */
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

function makeFace(pts: Pt[]): Face {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const height = dist(pts[10], pts[152]);
  const width = dist(pts[234], pts[454]);
  return {
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
    top: pts[10],
    chin: pts[152],
    height,
    width,
    size: Math.max(height, width),
    outline: FACE_OVAL.map((i) => pts[i]),
  };
}

function detectIn(lm: FaceLandmarker, src: CanvasImageSource, region: Box, maxSide: number): Face[] {
  const k = Math.min(1, maxSide / Math.max(region.w, region.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(region.w * k));
  c.height = Math.max(1, Math.round(region.h * k));
  c.getContext('2d')!.drawImage(src, region.x, region.y, region.w, region.h, 0, 0, c.width, c.height);
  return lm.detect(c).faceLandmarks.map((points) => makeFace(points.map((p) => ({ x: region.x + p.x * region.w, y: region.y + p.y * region.h }))));
}

function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/**
 * All faces, largest first. The detector only sees faces that fill a good part of its input, so it also looks in
 * overlapping 2×2 and 3×3 tiles (people in full-length shots); faces cut by a tile border are dropped.
 */
export async function findFaces(src: HTMLCanvasElement, opts: { tiles?: boolean } = {}): Promise<Face[]> {
  const lm = await load();
  const W = src.width;
  const H = src.height;
  const found = detectIn(lm, src, { x: 0, y: 0, w: W, h: H }, 1280);
  if (opts.tiles !== false) {
    for (const n of [2, 3]) {
      const tw = Math.min(W, (W / n) * 1.4);
      const th = Math.min(H, (H / n) * 1.4);
      if (Math.min(tw, th) < 200) break;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const x = ((W - tw) * i) / (n - 1);
          const y = ((H - th) * j) / (n - 1);
          const mx = tw * 0.02;
          const my = th * 0.02;
          for (const f of detectIn(lm, src, { x, y, w: tw, h: th }, 1024)) {
            const b = f.box;
            const ok =
              (x <= 0 || b.x > x + mx) && (y <= 0 || b.y > y + my) && (x + tw >= W - 1 || b.x + b.w < x + tw - mx) && (y + th >= H - 1 || b.y + b.h < y + th - my);
            if (ok) found.push(f);
          }
        }
      }
    }
  }
  const minSize = Math.max(14, Math.min(W, H) * 0.012);
  const sorted = found.filter((f) => f.size >= minSize).sort((a, b) => b.size - a.size);
  const out: Face[] = [];
  for (const f of sorted) if (!out.some((o) => iou(o.box, f.box) > 0.25)) out.push(f);
  return out;
}

/** Centre of the whole head (the face centre moved up towards the crown). */
export function headCenter(f: Face): Pt {
  const dx = f.top.x - f.chin.x;
  const dy = f.top.y - f.chin.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: f.center.x + (dx / len) * 0.22 * f.size, y: f.center.y + (dy / len) * 0.22 * f.size };
}
