import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import type { Point, Rect } from '../types';
import { flattenDoc, normalizeRect } from '../imageUtils';
import { brushStroke, buildMaskOverlay, fillPolygon, fillRect, maskBounds } from '../tools/mask';
import { fitViewport, screenToDoc, zoomAt } from './viewport';
import { MaskPromptBox } from '../PromptBox';

type Drag =
  | { kind: 'pan'; start: Point; vp0: { tx: number; ty: number } }
  | { kind: 'rect'; start: Point }
  | { kind: 'lasso'; points: Point[] }
  | { kind: 'brush'; last: Point; mode: 'add' | 'sub' }
  | { kind: 'crop'; handle: CropHandle; start: Point; rect0: Rect };

type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

const MIN_CROP = 16;

function makeChecker(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3a3a3e';
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = '#4a4a4f';
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillRect(8, 8, 8, 8);
  return c;
}

export function EditorCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const checkerRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tick, setTick] = useState(0);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [dash, setDash] = useState(0);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const doc = useEditor((s) => s.doc);
  const mask = useEditor((s) => s.mask);
  const maskVersion = useEditor((s) => s.maskVersion);
  const viewport = useEditor((s) => s.viewport);
  const setViewport = useEditor((s) => s.setViewport);
  const tool = useEditor((s) => s.tool);
  const brushSize = useEditor((s) => s.brushSize);
  const panel = useEditor((s) => s.panel);
  const cropRect = useEditor((s) => s.cropRect);
  const setCropRect = useEditor((s) => s.setCropRect);
  const previewCanvas = useEditor((s) => s.previewCanvas);
  const fitKey = useEditor((s) => s.fitKey);
  const bumpMask = useEditor((s) => s.bumpMask);
  const resetMask = useEditor((s) => s.resetMask);
  const busy = useEditor((s) => s.busy);

  const composite = useMemo(() => (doc ? flattenDoc(doc) : null), [doc]);
  const bounds = useMemo(() => (mask ? maskBounds(mask) : null), [mask, maskVersion]);
  const cropMode = panel === 'expandCrop' && !!cropRect;

  // Container size tracking
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit document to the screen when requested
  useEffect(() => {
    if (!doc || size.w === 0) return;
    // In crop mode fit the union of the document and the crop frame so an expanded frame stays visible.
    const rect: Rect = cropMode && cropRect
      ? {
          x: Math.min(0, cropRect.x),
          y: Math.min(0, cropRect.y),
          w: Math.max(doc.width, cropRect.x + cropRect.w) - Math.min(0, cropRect.x),
          h: Math.max(doc.height, cropRect.y + cropRect.h) - Math.min(0, cropRect.y),
        }
      : { x: 0, y: 0, w: doc.width, h: doc.height };
    const vp = fitViewport(rect.w, rect.h, size.w, size.h);
    setViewport({ ...vp, tx: vp.tx - rect.x * vp.scale, ty: vp.ty - rect.y * vp.scale });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, size.w === 0]);

  // Marching ants
  useEffect(() => {
    if (!bounds) return;
    const id = window.setInterval(() => setDash((d) => (d + 1) % 8), 110);
    return () => window.clearInterval(id);
  }, [bounds]);

  // Space = temporary pan
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        setSpaceHeld(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const getPos = useCallback((e: { clientX: number; clientY: number }): Point => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  // ---- Crop helpers ----
  const cropHandles = useCallback((): { id: CropHandle; x: number; y: number }[] => {
    if (!cropRect) return [];
    const { scale, tx, ty } = viewport;
    const x1 = cropRect.x * scale + tx;
    const y1 = cropRect.y * scale + ty;
    const x2 = x1 + cropRect.w * scale;
    const y2 = y1 + cropRect.h * scale;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    return [
      { id: 'nw', x: x1, y: y1 },
      { id: 'ne', x: x2, y: y1 },
      { id: 'sw', x: x1, y: y2 },
      { id: 'se', x: x2, y: y2 },
      { id: 'n', x: mx, y: y1 },
      { id: 's', x: mx, y: y2 },
      { id: 'w', x: x1, y: my },
      { id: 'e', x: x2, y: my },
    ];
  }, [cropRect, viewport]);

  const hitCrop = useCallback(
    (p: Point): CropHandle | null => {
      if (!cropRect) return null;
      for (const h of cropHandles()) {
        if (Math.abs(p.x - h.x) <= 12 && Math.abs(p.y - h.y) <= 12) return h.id;
      }
      const d = screenToDoc(viewport, p);
      if (d.x >= cropRect.x && d.y >= cropRect.y && d.x <= cropRect.x + cropRect.w && d.y <= cropRect.y + cropRect.h) return 'move';
      return null;
    },
    [cropRect, cropHandles, viewport],
  );

  // ---- Pointer handling ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (!doc || !mask || busy) return;
    const p = getPos(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const wantPan = e.button === 1 || spaceHeld || tool === 'hand';

    if (cropMode && !wantPan && e.button === 0) {
      const handle = hitCrop(p);
      if (handle && cropRect) {
        dragRef.current = { kind: 'crop', handle, start: p, rect0: cropRect };
      }
      return;
    }
    if (wantPan) {
      dragRef.current = { kind: 'pan', start: p, vp0: { tx: viewport.tx, ty: viewport.ty } };
      return;
    }
    if (e.button !== 0) return;
    const d = screenToDoc(viewport, p);
    switch (tool) {
      case 'rect':
        dragRef.current = { kind: 'rect', start: d };
        break;
      case 'lasso':
        dragRef.current = { kind: 'lasso', points: [d] };
        break;
      case 'brush':
      case 'eraser': {
        const mode = tool === 'eraser' || e.altKey ? 'sub' : 'add';
        brushStroke(mask, d, d, brushSize / 2, mode);
        dragRef.current = { kind: 'brush', last: d, mode };
        setTick((t) => t + 1);
        break;
      }
      default:
        break;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = getPos(e);
    setCursor(p);
    const drag = dragRef.current;
    if (!drag || !mask) return;
    switch (drag.kind) {
      case 'pan':
        setViewport({ ...viewport, tx: drag.vp0.tx + (p.x - drag.start.x), ty: drag.vp0.ty + (p.y - drag.start.y) });
        break;
      case 'rect':
      case 'lasso': {
        if (drag.kind === 'lasso') drag.points.push(screenToDoc(viewport, p));
        setTick((t) => t + 1);
        break;
      }
      case 'brush': {
        const d = screenToDoc(viewport, p);
        brushStroke(mask, drag.last, d, brushSize / 2, drag.mode);
        drag.last = d;
        setTick((t) => t + 1);
        break;
      }
      case 'crop': {
        const dx = (p.x - drag.start.x) / viewport.scale;
        const dy = (p.y - drag.start.y) / viewport.scale;
        const r0 = drag.rect0;
        let x1 = r0.x;
        let y1 = r0.y;
        let x2 = r0.x + r0.w;
        let y2 = r0.y + r0.h;
        const h = drag.handle;
        if (h === 'move') {
          x1 += dx;
          x2 += dx;
          y1 += dy;
          y2 += dy;
        } else {
          if (h.includes('w')) x1 = Math.min(x1 + dx, x2 - MIN_CROP);
          if (h.includes('e')) x2 = Math.max(x2 + dx, x1 + MIN_CROP);
          if (h.includes('n')) y1 = Math.min(y1 + dy, y2 - MIN_CROP);
          if (h.includes('s')) y2 = Math.max(y2 + dy, y1 + MIN_CROP);
        }
        setCropRect({ x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) });
        break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !mask) return;
    const p = getPos(e);
    const mode = e.altKey ? 'sub' : 'add';
    if (drag.kind === 'rect') {
      const d = screenToDoc(viewport, p);
      const r = normalizeRect(drag.start.x, drag.start.y, d.x, d.y);
      if (r.w > 1 && r.h > 1) {
        if (!e.shiftKey && mode === 'add') resetMask();
        fillRect(mask, r, mode);
      }
      bumpMask();
    } else if (drag.kind === 'lasso') {
      if (drag.points.length > 2) {
        if (!e.shiftKey && mode === 'add') resetMask();
        fillPolygon(mask, drag.points, mode);
      }
      bumpMask();
    } else if (drag.kind === 'brush') {
      bumpMask();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!doc) return;
    const p = getPos(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    setViewport(zoomAt(viewport, factor, p));
  };

  // ---- Drawing ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size.w * dpr) || canvas.height !== Math.round(size.h * dpr)) {
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!doc || !composite) return;

    const { scale, tx, ty } = viewport;
    const R: Rect = { x: tx, y: ty, w: doc.width * scale, h: doc.height * scale };
    if (!checkerRef.current) checkerRef.current = makeChecker();
    const pattern = ctx.createPattern(checkerRef.current, 'repeat')!;

    // Transparency checkerboard under the document (and under the expand area)
    const checkArea = cropMode && cropRect ? { x: cropRect.x * scale + tx, y: cropRect.y * scale + ty, w: cropRect.w * scale, h: cropRect.h * scale } : R;
    ctx.save();
    ctx.fillStyle = pattern;
    ctx.fillRect(checkArea.x, checkArea.y, checkArea.w, checkArea.h);
    if (cropMode) ctx.fillRect(R.x, R.y, R.w, R.h);
    ctx.restore();

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(previewCanvas ?? composite, R.x, R.y, R.w, R.h);

    // Selection overlay
    if (mask && (bounds || dragRef.current?.kind === 'brush')) {
      const ov = buildMaskOverlay(mask, viewport, { x: 0, y: 0, w: size.w, h: size.h }, dash);
      if (ov) ctx.drawImage(ov.canvas, ov.ox, ov.oy);
    }

    // In-progress shapes
    const drag = dragRef.current;
    if (drag && cursor) {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      if (drag.kind === 'rect') {
        const s = { x: drag.start.x * scale + tx, y: drag.start.y * scale + ty };
        ctx.strokeRect(s.x, s.y, cursor.x - s.x, cursor.y - s.y);
      } else if (drag.kind === 'lasso' && drag.points.length > 1) {
        ctx.beginPath();
        drag.points.forEach((pt, i) => {
          const sx = pt.x * scale + tx;
          const sy = pt.y * scale + ty;
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.stroke();
      }
      ctx.restore();
    }

    // Crop / expand frame
    if (cropMode && cropRect) {
      const cx = cropRect.x * scale + tx;
      const cy = cropRect.y * scale + ty;
      const cw = cropRect.w * scale;
      const ch = cropRect.h * scale;
      ctx.save();
      ctx.fillStyle = 'rgba(14,16,20,0.6)';
      ctx.beginPath();
      ctx.rect(0, 0, size.w, size.h);
      ctx.rect(cx, cy, cw, ch);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(cx, cy, cw, ch);
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 1;
      for (const h of cropHandles()) {
        const long = h.id.length === 1;
        const w = long && (h.id === 'n' || h.id === 's') ? 28 : 10;
        const hh = long && (h.id === 'e' || h.id === 'w') ? 28 : 10;
        ctx.beginPath();
        ctx.roundRect(h.x - w / 2, h.y - hh / 2, w, hh, 3);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Brush cursor
    if (cursor && (tool === 'brush' || tool === 'eraser') && !cropMode && !spaceHeld) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, (brushSize / 2) * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, (brushSize / 2) * scale + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }, [doc, composite, previewCanvas, viewport, size, mask, maskVersion, tick, bounds, dash, cursor, tool, brushSize, cropMode, cropRect, cropHandles, spaceHeld]);

  // ---- Cursor style ----
  let cursorStyle = 'default';
  if (spaceHeld || tool === 'hand') cursorStyle = dragRef.current?.kind === 'pan' ? 'grabbing' : 'grab';
  else if (cropMode) {
    const h = cursor ? hitCrop(cursor) : null;
    cursorStyle = h === 'move' ? 'move' : h ? `${h}-resize` : 'default';
  } else if (tool === 'brush' || tool === 'eraser') cursorStyle = 'none';
  else if (tool === 'rect' || tool === 'lasso') cursorStyle = 'crosshair';

  // ---- Floating prompt position ----
  let promptStyle: React.CSSProperties | null = null;
  if (bounds && !cropMode && size.w > 0) {
    const { scale, tx, ty } = viewport;
    const bx = bounds.x * scale + tx;
    const by = bounds.y * scale + ty;
    const bw = bounds.w * scale;
    const bh = bounds.h * scale;
    const boxW = 360;
    const left = Math.min(Math.max(8, bx + bw / 2 - boxW / 2), Math.max(8, size.w - boxW - 8));
    let top = by + bh + 12;
    if (top > size.h - 130) top = Math.max(8, by - 130);
    promptStyle = { left, top, width: boxW };
  }

  let cropLabel: React.CSSProperties | null = null;
  if (cropMode && cropRect) {
    const { scale, tx, ty } = viewport;
    cropLabel = { left: (cropRect.x + cropRect.w / 2) * scale + tx, top: (cropRect.y + cropRect.h) * scale + ty + 14 };
  }

  return (
    <div
      ref={containerRef}
      className="canvas-host"
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} />
      {promptStyle && <MaskPromptBox style={promptStyle} onClear={resetMask} />}
      {cropLabel && cropRect && (
        <div className="crop-label" style={cropLabel}>
          {cropRect.w} × {cropRect.h}
        </div>
      )}
    </div>
  );
}
