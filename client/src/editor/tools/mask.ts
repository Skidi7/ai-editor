import { createCanvas, ctx2d } from '../imageUtils';
import type { Point, Rect, Viewport } from '../types';

export type MaskMode = 'add' | 'sub';

export const MASK_COLOR = '#ffffff';

export function createMask(width: number, height: number): HTMLCanvasElement {
  return createCanvas(width, height);
}

export function clearMask(mask: HTMLCanvasElement) {
  ctx2d(mask).clearRect(0, 0, mask.width, mask.height);
}

function begin(mask: HTMLCanvasElement, mode: MaskMode): CanvasRenderingContext2D {
  const ctx = ctx2d(mask);
  ctx.globalCompositeOperation = mode === 'add' ? 'source-over' : 'destination-out';
  ctx.fillStyle = MASK_COLOR;
  ctx.strokeStyle = MASK_COLOR;
  return ctx;
}

export function fillRect(mask: HTMLCanvasElement, rect: Rect, mode: MaskMode = 'add') {
  const ctx = begin(mask, mode);
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.globalCompositeOperation = 'source-over';
}

export function fillPolygon(mask: HTMLCanvasElement, points: Point[], mode: MaskMode = 'add') {
  if (points.length < 3) return;
  const ctx = begin(mask, mode);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

export function brushStroke(mask: HTMLCanvasElement, from: Point, to: Point, radius: number, mode: MaskMode) {
  const ctx = begin(mask, mode);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = radius * 2;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(to.x, to.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

/** Bounding box of painted pixels, or null if the mask is empty. */
export function maskBounds(mask: HTMLCanvasElement): Rect | null {
  const { width, height } = mask;
  const d = ctx2d(mask).getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (d[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Builds the selection overlay for the visible part of the document: translucent blue fill inside the mask
 * and a dashed ("marching ants") outline along its edge. Returned canvas is in screen pixels and should be
 * drawn at (ox, oy).
 */
export function buildMaskOverlay(
  mask: HTMLCanvasElement,
  vp: Viewport,
  screenClip: Rect,
  dashOffset: number,
): { canvas: HTMLCanvasElement; ox: number; oy: number } | null {
  const docScreen: Rect = { x: vp.tx, y: vp.ty, w: mask.width * vp.scale, h: mask.height * vp.scale };
  const x1 = Math.max(docScreen.x, screenClip.x);
  const y1 = Math.max(docScreen.y, screenClip.y);
  const x2 = Math.min(docScreen.x + docScreen.w, screenClip.x + screenClip.w);
  const y2 = Math.min(docScreen.y + docScreen.h, screenClip.y + screenClip.h);
  const w = Math.floor(x2 - x1);
  const h = Math.floor(y2 - y1);
  if (w <= 0 || h <= 0) return null;

  // Rasterise the mask at screen resolution for the clip region.
  const raster = createCanvas(w, h);
  const rctx = ctx2d(raster);
  rctx.imageSmoothingEnabled = false;
  rctx.setTransform(vp.scale, 0, 0, vp.scale, vp.tx - x1, vp.ty - y1);
  rctx.drawImage(mask, 0, 0);
  const src = rctx.getImageData(0, 0, w, h).data;

  const out = rctx.createImageData(w, h);
  const o = out.data;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] > 127;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!inside(x, y)) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      if (edge) {
        const dash = ((x + y + dashOffset) >> 2) & 1;
        if (dash) {
          o[i] = 255;
          o[i + 1] = 255;
          o[i + 2] = 255;
        } else {
          o[i] = 34;
          o[i + 1] = 211;
          o[i + 2] = 238;
        }
        o[i + 3] = 255;
      } else {
        o[i] = 34;
        o[i + 1] = 211;
        o[i + 2] = 238;
        o[i + 3] = 80;
      }
    }
  }
  rctx.setTransform(1, 0, 0, 1, 0, 0);
  rctx.putImageData(out, 0, 0);
  return { canvas: raster, ox: x1, oy: y1 };
}

/** Copy of `image` with the mask region outlined in red and lightly tinted — what Seedream gets as "image 2". */
export function buildMarkedImage(image: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(image.width, image.height);
  const ctx = ctx2d(c);
  ctx.drawImage(image, 0, 0);

  const tint = createCanvas(image.width, image.height);
  const tctx = ctx2d(tint);
  tctx.drawImage(mask, 0, 0, tint.width, tint.height);
  tctx.globalCompositeOperation = 'source-in';
  tctx.fillStyle = 'rgba(255,0,0,0.28)';
  tctx.fillRect(0, 0, tint.width, tint.height);
  ctx.drawImage(tint, 0, 0);

  // Outline: draw the mask shifted in 8 directions in red, then punch out the original mask shape.
  const strokePx = Math.max(3, Math.round(Math.max(image.width, image.height) / 300));
  const outline = createCanvas(image.width, image.height);
  const octx = ctx2d(outline);
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    octx.drawImage(mask, Math.cos(ang) * strokePx, Math.sin(ang) * strokePx, outline.width, outline.height);
  }
  octx.globalCompositeOperation = 'destination-out';
  octx.drawImage(mask, 0, 0, outline.width, outline.height);
  octx.globalCompositeOperation = 'source-in';
  octx.fillStyle = 'rgb(255,0,0)';
  octx.fillRect(0, 0, outline.width, outline.height);
  ctx.drawImage(outline, 0, 0);
  return c;
}
