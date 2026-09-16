import type { Point, Viewport } from '../types';

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 16;

export function fitViewport(docW: number, docH: number, viewW: number, viewH: number, padding = 48): Viewport {
  const scale = Math.min((viewW - padding * 2) / docW, (viewH - padding * 2) / docH, 1.5);
  const s = Math.max(MIN_SCALE, scale);
  return { scale: s, tx: (viewW - docW * s) / 2, ty: (viewH - docH * s) / 2 };
}

export function screenToDoc(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.tx) / vp.scale, y: (p.y - vp.ty) / vp.scale };
}

export function docToScreen(vp: Viewport, p: Point): Point {
  return { x: p.x * vp.scale + vp.tx, y: p.y * vp.scale + vp.ty };
}

/** Zooms by `factor` keeping the screen point `at` fixed. */
export function zoomAt(vp: Viewport, factor: number, at: Point): Viewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vp.scale * factor));
  const k = scale / vp.scale;
  return { scale, tx: at.x - (at.x - vp.tx) * k, ty: at.y - (at.y - vp.ty) * k };
}

export function zoomTo(vp: Viewport, scale: number, at: Point): Viewport {
  return zoomAt(vp, scale / vp.scale, at);
}
