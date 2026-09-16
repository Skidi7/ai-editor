import type { RelightSettings } from './api';
import { createCanvas, ctx2d } from './imageUtils';

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [255, 255, 255];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/**
 * Visual guide for the model: the same photo with (1) the shadow side darkened by a linear gradient and
 * (2) a lamp icon at the edge with an arrow pointing the way the light travels. Nothing bright is added on
 * top of the photo, so there is no glow the model could mistake for haze.
 */
export function renderLightPreview(src: HTMLCanvasElement, light: RelightSettings): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.drawImage(src, 0, 0);

  const az = (light.azimuth * Math.PI) / 180;
  const el = (light.elevation * Math.PI) / 180;
  // Direction in the image plane (x right, y down) — where the light comes FROM.
  let dx = Math.sin(az) * Math.cos(el);
  let dy = -Math.sin(el);
  const len = Math.hypot(dx, dy);
  const inPlane = Math.min(1, len); // ~0 = light from the camera
  if (len > 1e-3) {
    dx /= len;
    dy /= len;
  }
  const cx = w / 2;
  const cy = h / 2;
  const minSide = Math.min(w, h);
  const k = 0.25 + 0.75 * (light.brightness / 100);
  const [r, g, b] = hexToRgb(light.color);
  const rgba = (a: number) => `rgba(${r},${g},${b},${a})`;

  // 1. Shadow side: linear darkening from the lit edge to the opposite edge.
  if (inPlane > 0.2) {
    const reach = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    const lit = { x: cx + dx * reach, y: cy + dy * reach };
    const dark = { x: cx - dx * reach, y: cy - dy * reach };
    const grad = ctx.createLinearGradient(lit.x, lit.y, dark.x, dark.y);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.45, `rgba(0,0,0,${0.12 * k})`);
    grad.addColorStop(1, `rgba(0,0,0,${0.6 * k})`);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // 2. Lamp icon at the edge + arrow toward the subject (or at the centre for light from the camera).
  const margin = Math.round(minSide * 0.07);
  const ex = inPlane > 0.2 ? Math.min(w - margin, Math.max(margin, cx + dx * (w / 2 - margin))) : cx;
  const ey = inPlane > 0.2 ? Math.min(h - margin, Math.max(margin, cy + dy * (h / 2 - margin))) : cy - minSide * 0.25;
  const rad = Math.max(10, Math.round(minSide * 0.028));
  const lw = Math.max(3, Math.round(minSide * 0.008));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // rays
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = lw + 2;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(ex + Math.cos(a) * rad * 1.4, ey + Math.sin(a) * rad * 1.4);
    ctx.lineTo(ex + Math.cos(a) * rad * 2.1, ey + Math.sin(a) * rad * 2.1);
    ctx.stroke();
  }
  ctx.strokeStyle = rgba(1);
  ctx.lineWidth = lw;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(ex + Math.cos(a) * rad * 1.4, ey + Math.sin(a) * rad * 1.4);
    ctx.lineTo(ex + Math.cos(a) * rad * 2.1, ey + Math.sin(a) * rad * 2.1);
    ctx.stroke();
  }
  // disc
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.beginPath();
  ctx.arc(ex, ey, rad + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = rgba(1);
  ctx.beginPath();
  ctx.arc(ex, ey, rad, 0, Math.PI * 2);
  ctx.fill();

  // arrow from the lamp toward the subject (image centre)
  const ax = inPlane > 0.2 ? -dx : 0;
  const ay = inPlane > 0.2 ? -dy : 1;
  const start = { x: ex + ax * rad * 2.6, y: ey + ay * rad * 2.6 };
  const alen = minSide * 0.22;
  const end = { x: start.x + ax * alen, y: start.y + ay * alen };
  const head = rad * 1.1;
  const ang = Math.atan2(ay, ax);
  const drawArrow = () => {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - Math.cos(ang - 0.5) * head, end.y - Math.sin(ang - 0.5) * head);
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - Math.cos(ang + 0.5) * head, end.y - Math.sin(ang + 0.5) * head);
    ctx.stroke();
  };
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = lw + 3;
  drawArrow();
  ctx.strokeStyle = rgba(1);
  ctx.lineWidth = lw;
  drawArrow();
  ctx.restore();
  return c;
}
