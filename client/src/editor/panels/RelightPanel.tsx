import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import { runRelight } from '../actions';
import type { RelightSettings } from '../api';
import { downscaleToFit, flattenDoc } from '../imageUtils';
import { IconSparkle } from '../Icons';

const QUICK: { label: string; az: number; el: number }[] = [
  { label: 'Top', az: 0, el: 80 },
  { label: 'Front', az: 0, el: 5 },
  { label: 'Right', az: 90, el: 10 },
  { label: 'Left', az: -90, el: 10 },
  { label: 'Bottom', az: 0, el: -75 },
];

const SWATCHES = ['#FFFFFF', '#FFD27A', '#FF8A3D', '#5FD3FF', '#FF6BD6', '#8CFF8C'];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

const SIZE = 320;
const CX = SIZE / 2;
const CY = SIZE / 2 - 6;
const R = 118; // orbit radius (px) of the lamp around the card
const CARD_W = 84;
const CARD_H = 106;

/** 3D → widget: x right, y up, z toward the viewer. Slightly elevated camera so "in front" sits lower on screen. */
function project(az: number, el: number): { x: number; y: number; z: number } {
  const a = rad(az);
  const e = rad(el);
  const X = Math.sin(a) * Math.cos(e);
  const Y = Math.sin(e);
  const Z = Math.cos(a) * Math.cos(e);
  return { x: CX + X * R, y: CY - Y * R * 0.82 + Z * R * 0.3, z: Z };
}

/** Widget point → direction (front hemisphere only). */
function unproject(px: number, py: number): { az: number; el: number } {
  let X = (px - CX) / R;
  let Y = -(py - CY) / (R * 0.82);
  const len = Math.hypot(X, Y);
  if (len > 0.995) {
    X /= len / 0.995;
    Y /= len / 0.995;
  }
  const el = clamp(deg(Math.asin(clamp(Y, -1, 1))), -85, 85);
  const cosEl = Math.max(0.05, Math.cos(rad(el)));
  const az = deg(Math.asin(clamp(X / cosEl, -1, 1)));
  return { az: clamp(az, -90, 90), el };
}

function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/** Spotlight "can" pointed at the card, with a glowing lens on the front. */
function drawSpot(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, k: number, dim: boolean) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalAlpha = dim ? 0.6 : 1;
  // body
  ctx.fillStyle = '#2b2b31';
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(-18, -9, 26, 18, 4);
  ctx.fill();
  ctx.stroke();
  // barn-door rim
  ctx.fillStyle = '#3a3a41';
  ctx.beginPath();
  ctx.roundRect(4, -11, 6, 22, 2);
  ctx.fill();
  ctx.stroke();
  // lens
  ctx.shadowColor = color;
  ctx.shadowBlur = 8 + 22 * k;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(9, 0, 3.5, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Light-direction widget: the photo stands on a floor grid, the lamp can be placed anywhere around it. */
function LightWidget({
  thumb,
  azimuth,
  elevation,
  color,
  brightness,
  onChange,
}: {
  thumb: HTMLCanvasElement | null;
  azimuth: number;
  elevation: number;
  color: string;
  brightness: number;
  onChange: (az: number, el: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const behind = false;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = SIZE * dpr;
    c.height = SIZE * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Floor grid in perspective
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    const gy0 = CY + 20;
    const gy1 = SIZE - 14;
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      ctx.beginPath();
      ctx.moveTo(CX - 90 + t * 180, gy0);
      ctx.lineTo(CX - 155 + t * 310, gy1);
      ctx.stroke();
      const y = gy0 + (gy1 - gy0) * t * t;
      const half = 90 + 65 * t * t;
      ctx.beginPath();
      ctx.moveTo(CX - half, y);
      ctx.lineTo(CX + half, y);
      ctx.stroke();
    }
    ctx.restore();

    const L = project(azimuth, elevation);
    const k = 0.15 + 0.7 * (brightness / 100);
    const cardL = CX - CARD_W / 2;
    const cardT = CY - CARD_H / 2;

    const drawCone = () => {
      // From the lamp to the two card corners facing it.
      const corners = [
        [cardL, cardT],
        [cardL + CARD_W, cardT],
        [cardL + CARD_W, cardT + CARD_H],
        [cardL, cardT + CARD_H],
      ];
      const angTo = (p: number[]) => Math.atan2(p[1] - L.y, p[0] - L.x);
      const center = Math.atan2(CY - L.y, CX - L.x);
      let minA = Infinity;
      let maxA = -Infinity;
      let pMin = corners[0];
      let pMax = corners[0];
      for (const p of corners) {
        let d = angTo(p) - center;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        if (d < minA) {
          minA = d;
          pMin = p;
        }
        if (d > maxA) {
          maxA = d;
          pMax = p;
        }
      }
      // Beam starts at the lens (a little in front of the lamp body) and widens to cover the card.
      const dir = Math.atan2(CY - L.y, CX - L.x);
      const sx = L.x + Math.cos(dir) * 12;
      const sy = L.y + Math.sin(dir) * 12;
      const dist = Math.hypot(CX - sx, CY - sy) + 40;
      const g = ctx.createRadialGradient(sx, sy, 2, sx, sy, dist);
      g.addColorStop(0, hexToRgba(color, (behind ? 0.5 : 0.8) * k));
      g.addColorStop(1, hexToRgba(color, 0.06 * k));
      ctx.save();
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(dir + Math.PI / 2) * 5, sy + Math.sin(dir + Math.PI / 2) * 5);
      ctx.lineTo(pMin[0], pMin[1]);
      ctx.lineTo(pMax[0], pMax[1]);
      ctx.lineTo(sx + Math.cos(dir - Math.PI / 2) * 5, sy + Math.sin(dir - Math.PI / 2) * 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const drawCard = () => {
      ctx.save();
      ctx.fillStyle = '#1e1e22';
      ctx.fillRect(cardL - 3, cardT - 3, CARD_W + 6, CARD_H + 6);
      if (thumb) ctx.drawImage(thumb, cardL, cardT, CARD_W, CARD_H);
      else {
        ctx.fillStyle = '#555';
        ctx.fillRect(cardL, cardT, CARD_W, CARD_H);
      }
      // Where the light lands: a coloured glow on the side facing the lamp (or a rim when the lamp is behind).
      const dx = L.x - CX;
      const dy = L.y - CY;
      const len = Math.hypot(dx, dy) || 1;
      const nx = dx / len;
      const ny = dy / len;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cardL, cardT, CARD_W, CARD_H);
      ctx.clip();
      if (!behind) {
        const g = ctx.createLinearGradient(CX + nx * CARD_W * 0.7, CY + ny * CARD_H * 0.7, CX - nx * CARD_W * 0.7, CY - ny * CARD_H * 0.7);
        g.addColorStop(0, hexToRgba(color, 0.75 * k));
        g.addColorStop(0.55, hexToRgba(color, 0.15 * k));
        g.addColorStop(1, `rgba(0,0,0,${0.45 * k})`);
        ctx.fillStyle = g;
        ctx.fillRect(cardL, cardT, CARD_W, CARD_H);
      } else {
        ctx.fillStyle = `rgba(0,0,0,${0.35 * k})`;
        ctx.fillRect(cardL, cardT, CARD_W, CARD_H);
        ctx.strokeStyle = hexToRgba(color, 0.9 * k);
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(CX + nx * 60, CY + ny * 70);
        ctx.lineTo(CX + nx * 60 - ny * 80, CY + ny * 70 + nx * 80);
        ctx.moveTo(CX + nx * 60, CY + ny * 70);
        ctx.lineTo(CX + nx * 60 + ny * 80, CY + ny * 70 - nx * 80);
        ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
    };

    const drawLamp = () => {
      drawSpot(ctx, L.x, L.y, Math.atan2(CY - L.y, CX - L.x), color, k, behind);
    };

    if (behind) {
      drawLamp();
      drawCone();
      drawCard();
    } else {
      drawCone();
      drawCard();
      drawLamp();
    }
  }, [thumb, azimuth, elevation, color, brightness, behind]);

  const place = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const p = unproject(e.clientX - r.left, e.clientY - r.top);
    onChange(p.az, p.el);
  };

  return (
    <div className="light-widget">
      <div className="muted small center">Hold and drag to place the light</div>
      <button className="lw-arrow up" onClick={() => onChange(azimuth, clamp(elevation + 15, -85, 85))}>
        ˄
      </button>
      <button className="lw-arrow down" onClick={() => onChange(azimuth, clamp(elevation - 15, -85, 85))}>
        ˅
      </button>
      <button className="lw-arrow left" onClick={() => onChange(clamp(azimuth - 15, -90, 90), elevation)}>
        ‹
      </button>
      <button className="lw-arrow right" onClick={() => onChange(clamp(azimuth + 15, -90, 90), elevation)}>
        ›
      </button>
      <canvas
        ref={ref}
        style={{ width: SIZE, height: SIZE, cursor: 'grab', touchAction: 'none' }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragging.current = true;
          place(e);
        }}
        onPointerMove={(e) => dragging.current && place(e)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      />
      <div className="lw-foot">
        <span className="muted small">
          {Math.round(azimuth)}° / {Math.round(elevation)}°
        </span>
      </div>
    </div>
  );
}

export function RelightPanel() {
  const doc = useEditor((s) => s.doc);
  const busy = useEditor((s) => s.busy);
  const [light, setLight] = useState<RelightSettings>({ azimuth: 45, elevation: 30, brightness: 50, color: '#FFFFFF' });
  const [hexInput, setHexInput] = useState('#FFFFFF');

  const thumb = useMemo(() => (doc ? downscaleToFit(flattenDoc(doc), 220).canvas : null), [doc]);
  if (!doc) return null;

  const set = (patch: Partial<RelightSettings>) => setLight((l) => ({ ...l, ...patch }));
  const setColor = (c: string) => {
    set({ color: c.toUpperCase() });
    setHexInput(c.toUpperCase());
  };
  const activeQuick = QUICK.find((q) => Math.abs(q.az - light.azimuth) < 1 && Math.abs(q.el - light.elevation) < 1)?.label;

  return (
    <div className="panel-body relight">
      <div className="ratio-label">Quick select</div>
      <div className="quick-grid">
        {QUICK.map((q) => (
          <button key={q.label} className={`chip big ${activeQuick === q.label ? 'active' : ''}`} onClick={() => set({ azimuth: q.az, elevation: q.el })}>
            {q.label}
          </button>
        ))}
      </div>

      <LightWidget
        thumb={thumb}
        azimuth={light.azimuth}
        elevation={light.elevation}
        color={light.color}
        brightness={light.brightness}
        onChange={(az, el) => set({ azimuth: az, elevation: el })}
      />

      <div className="ratio-label">Light settings</div>

      <label className="slider">
        <span className="slider-head">
          <span>Intensity</span>
          <span className="slider-value">{light.brightness}%</span>
        </span>
        <input type="range" min={5} max={100} value={light.brightness} onChange={(e) => set({ brightness: Number(e.target.value) })} />
      </label>

      <div className="row card color-row">
        <span>Color</span>
        <span className="spacer" />
        <div className="swatches">
          {SWATCHES.map((c) => (
            <button key={c} className={`swatch ${light.color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} title={c} />
          ))}
        </div>
        <input type="color" value={light.color} onChange={(e) => setColor(e.target.value)} title="Custom colour" />
        <input
          className="hex"
          value={hexInput}
          onChange={(e) => {
            setHexInput(e.target.value);
            if (/^#[0-9a-f]{6}$/i.test(e.target.value)) set({ color: e.target.value.toUpperCase() });
          }}
        />
      </div>

      <button className="accent" disabled={!!busy} onClick={() => void runRelight(light)}>
        <IconSparkle width={18} height={18} /> Generate
      </button>
    </div>
  );
}
