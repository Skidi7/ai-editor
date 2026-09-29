import { useEffect, useMemo, useRef, useState } from 'react';
import { columnPeaks } from '../audio';
import { formatClock } from '../text';

export interface Range {
  start: number;
  end: number;
}

const VIEW_MAX = 60;
const HANDLE_PX = 9;

function tickStep(secondsPerPx: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s / secondsPerPx >= 70) return s;
  return 300;
}

/**
 * Waveform with a selectable fragment. Drag the edges to trim, drag inside to move, drag elsewhere to select anew.
 * Files longer than a minute show a minute at a time; the strip above is the whole file (click it to jump).
 */
export function Waveform({
  mono,
  sampleRate,
  sel,
  onSel,
  playhead,
  minSel = 1,
  maxSel = 30,
}: {
  mono: Float32Array;
  sampleRate: number;
  sel: Range;
  onSel: (r: Range) => void;
  playhead: number | null;
  minSel?: number;
  maxSel?: number;
}) {
  const duration = mono.length / sampleRate;
  const hostRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const long = duration > VIEW_MAX;
  const viewLen = long ? VIEW_MAX : duration;
  const [viewStart, setViewStart] = useState(0);
  const drag = useRef<{ mode: 'start' | 'end' | 'move' | 'new'; anchor: number; orig: Range } | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the selection in view when it changes from outside (auto-pick, new file).
  useEffect(() => {
    if (!long) {
      setViewStart(0);
      return;
    }
    setViewStart((v) => {
      if (sel.start >= v && sel.end <= v + viewLen) return v;
      const centre = (sel.start + sel.end) / 2;
      return Math.max(0, Math.min(duration - viewLen, centre - viewLen / 2));
    });
  }, [sel.start, sel.end, long, viewLen, duration]);

  const miniPeaks = useMemo(() => (long ? columnPeaks(mono, 0, mono.length, 600) : null), [mono, long]);

  const v0 = long ? viewStart : 0;
  const v1 = v0 + viewLen;
  const tx = (t: number) => ((t - v0) / (v1 - v0)) * width;
  const xt = (x: number) => v0 + (x / width) * (v1 - v0);

  // ----- Draw main -----
  useEffect(() => {
    const c = mainRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 120;
    c.width = Math.round(width * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${h}px`;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, h);
    const top = 18;
    const wh = h - top - 4;
    const mid = top + wh / 2;
    // Ticks
    const step = tickStep((v1 - v0) / width);
    g.fillStyle = '#6b7389';
    g.font = '10px Segoe UI, sans-serif';
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) {
      const x = Math.round(tx(t)) + 0.5;
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x, h);
      g.stroke();
      g.fillText(formatClock(t).replace(/\.0$/, ''), x + 3, 11);
    }
    // Waveform
    const peaks = columnPeaks(mono, Math.floor(v0 * sampleRate), Math.floor(v1 * sampleRate), width);
    let max = 0.02;
    for (const p of peaks) max = Math.max(max, p);
    const k = (wh / 2 - 2) / Math.min(1, max * 1.05);
    const sx0 = tx(sel.start);
    const sx1 = tx(sel.end);
    for (let x = 0; x < width; x++) {
      const a = Math.max(0.5, peaks[x] * k);
      g.fillStyle = x >= sx0 && x <= sx1 ? '#a78bfa' : '#4a5168';
      g.fillRect(x, mid - a, 1, a * 2);
    }
    // Selection
    g.fillStyle = 'rgba(139, 92, 246, 0.14)';
    g.fillRect(sx0, top, sx1 - sx0, wh);
    g.fillStyle = '#8b5cf6';
    for (const x of [sx0, sx1]) {
      g.fillRect(Math.round(x) - 1, top, 2, wh);
      g.beginPath();
      g.roundRect(Math.round(x) - 5, mid - 14, 10, 28, 4);
      g.fill();
    }
    // Playhead
    if (playhead !== null && playhead >= v0 && playhead <= v1) {
      g.fillStyle = '#ffffff';
      g.fillRect(Math.round(tx(playhead)), top, 2, wh);
    }
  }, [mono, sampleRate, width, v0, v1, sel.start, sel.end, playhead]);

  // ----- Draw minimap -----
  useEffect(() => {
    const c = miniRef.current;
    if (!c || !miniPeaks) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 30;
    c.width = Math.round(width * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${h}px`;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, h);
    let max = 0.02;
    for (const p of miniPeaks) max = Math.max(max, p);
    const colW = width / miniPeaks.length;
    g.fillStyle = '#3b4257';
    miniPeaks.forEach((p, i) => {
      const a = Math.max(0.5, (p / max) * (h / 2 - 2));
      g.fillRect(i * colW, h / 2 - a, Math.max(1, colW - 0.3), a * 2);
    });
    const mx = (t: number) => (t / duration) * width;
    g.fillStyle = 'rgba(139, 92, 246, 0.8)';
    g.fillRect(mx(sel.start), 0, Math.max(2, mx(sel.end) - mx(sel.start)), h);
    g.strokeStyle = '#22d3ee';
    g.lineWidth = 1.5;
    g.strokeRect(mx(v0) + 0.75, 0.75, mx(v1) - mx(v0) - 1.5, h - 1.5);
  }, [miniPeaks, width, duration, v0, v1, sel.start, sel.end]);

  const clampRange = (r: Range): Range => {
    let { start, end } = r;
    if (end - start > maxSel) end = start + maxSel;
    start = Math.max(0, start);
    end = Math.min(duration, end);
    if (end - start < minSel) {
      if (start + minSel <= duration) end = start + minSel;
      else start = Math.max(0, end - minSel);
    }
    return { start, end };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = xt(x);
    const sx0 = tx(sel.start);
    const sx1 = tx(sel.end);
    let mode: 'start' | 'end' | 'move' | 'new' = 'new';
    if (Math.abs(x - sx0) <= HANDLE_PX) mode = 'start';
    else if (Math.abs(x - sx1) <= HANDLE_PX) mode = 'end';
    else if (x > sx0 && x < sx1) mode = 'move';
    drag.current = { mode, anchor: t, orig: sel };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const d = drag.current;
    if (!d) {
      const sx0 = tx(sel.start);
      const sx1 = tx(sel.end);
      e.currentTarget.style.cursor = Math.abs(x - sx0) <= HANDLE_PX || Math.abs(x - sx1) <= HANDLE_PX ? 'ew-resize' : x > sx0 && x < sx1 ? 'grab' : 'crosshair';
      return;
    }
    const t = Math.max(0, Math.min(duration, xt(x)));
    if (d.mode === 'start') onSel(clampRange({ start: Math.min(t, d.orig.end - minSel), end: d.orig.end }));
    else if (d.mode === 'end') onSel(clampRange({ start: d.orig.start, end: Math.max(t, d.orig.start + minSel) }));
    else if (d.mode === 'move') {
      const len = d.orig.end - d.orig.start;
      const start = Math.max(0, Math.min(duration - len, d.orig.start + (t - d.anchor)));
      onSel({ start, end: start + len });
    } else if (Math.abs(t - d.anchor) > 0.1) {
      onSel(clampRange({ start: Math.min(t, d.anchor), end: Math.max(t, d.anchor) }));
    }
  };

  const onUp = () => {
    drag.current = null;
  };

  const onMini = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.type === 'pointermove' && e.buttons !== 1) return;
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * duration;
    setViewStart(Math.max(0, Math.min(duration - viewLen, t - viewLen / 2)));
  };

  return (
    <div className="vc-wave" ref={hostRef}>
      {long && <canvas ref={miniRef} className="vc-wave-mini" onPointerDown={onMini} onPointerMove={onMini} title="Whole file: click to jump" />}
      <canvas ref={mainRef} className="vc-wave-main" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
    </div>
  );
}
