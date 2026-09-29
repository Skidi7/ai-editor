import type { Insert, InsertFrame, Project, Tier } from './types';
import { clipAt, type ClipTL, type Timeline } from './timeline';

/**
 * Draws one frame of the composition at time `t`. The same function drives the live preview and the export,
 * so what you see is what gets recorded. All sizes are relative to the canvas width (720 = 1×).
 * It also returns the layout of the frame (where inserts and captions landed) so the preview can hit-test drags.
 */

export interface Assets {
  image(url: string | null): HTMLImageElement | null;
  video(sceneId: string): HTMLVideoElement | null;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameLayout {
  inserts: { id: string; box: Box }[];
  caption: Box | null;
}

export interface DrawOptions {
  /** Preview-only overlays: outline + resize handle for the selected insert, caption drag hint. */
  selectedInsertId?: string | null;
  showGuides?: boolean;
  /** Preview-only: label scenes whose replacement has not been generated yet. */
  previewLabels?: boolean;
}

const TIER_COLORS: Record<Tier, string> = { S: '#EE5F52', A: '#F5A65B', B: '#F7D154', C: '#E5F57A', D: '#A6DA7B' };
const TIERS: Tier[] = ['S', 'A', 'B', 'C', 'D'];

const ENTER = 0.22;
const EXIT = 0.16;

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}
function easeOutBounce(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, W: number, H: number) {
  if (!sw || !sh) return;
  const k = Math.max(W / sw, H / sh);
  const cw = W / k;
  const ch = H / k;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);
}

/** Preset placements (centre x / y as fractions of the canvas), mirroring the example's AspectFrames. */
export function insertPlacement(frame: InsertFrame, aspect: string): { cx: number; cy: number } {
  const portrait = aspect === '9:16';
  switch (frame) {
    case 'left':
      return { cx: 0.34, cy: portrait ? 0.78 : 0.7 };
    case 'right':
      return { cx: 0.7, cy: portrait ? 0.8 : 0.7 };
    case 'wide':
      return { cx: 0.5, cy: portrait ? 0.78 : 0.7 };
    case 'top':
      return { cx: 0.5, cy: portrait ? 0.24 : 0.28 };
    default:
      return { cx: 0.5, cy: 0.5 };
  }
}

export function insertAspectValue(insert: Insert, img: HTMLImageElement | null): number {
  if (img && img.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight;
  const [a, b] = insert.aspect.split(':').map(Number);
  return a / b;
}

/** Where an insert sits on a W×H canvas (before enter/exit animation). */
export function insertBox(insert: Insert, img: HTMLImageElement | null, W: number, H: number, aspect: string): Box {
  const ar = insertAspectValue(insert, img);
  const w = W * (insert.width / 100);
  const h = w / ar;
  const preset = insertPlacement(insert.frame, aspect);
  const cx = insert.x ?? preset.cx;
  const cy = insert.y ?? preset.cy;
  return { x: W * cx - w / 2, y: H * cy - h / 2, w, h };
}

function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number, project: Project, clip: ClipTL | null, assets: Assets) {
  ctx.fillStyle = project.style.background || '#090A0F';
  ctx.fillRect(0, 0, W, H);
  if (!clip) return;
  const video = clip.video ? assets.video(clip.scene.id) : null;
  if (video && video.readyState >= 2 && video.videoWidth) {
    drawCover(ctx, video, video.videoWidth, video.videoHeight, W, H);
    return;
  }
  const still = assets.image(clip.still);
  if (still && still.naturalWidth) {
    drawCover(ctx, still, still.naturalWidth, still.naturalHeight, W, H);
    return;
  }
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1c2030');
  g.addColorStop(1, '#0e1014');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawBoard(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, project: Project, tl: Timeline, assets: Assets) {
  const board = project.style.board;
  if (!board.enabled) return;
  const u = W / 720;
  const top = H * Math.min(0.9, Math.max(0.2, board.top));
  const rowH = (H - top) / TIERS.length;
  const labelW = Math.max(56 * u, rowH * 0.95);
  ctx.save();
  ctx.fillStyle = 'rgba(43, 43, 48, 0.94)';
  ctx.fillRect(0, top, W, H - top);
  ctx.font = `700 ${Math.round(rowH * 0.42)}px Inter, "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  TIERS.forEach((tier, ri) => {
    const y = top + ri * rowH;
    ctx.fillStyle = ri % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, y, W, rowH);
    ctx.fillStyle = TIER_COLORS[tier];
    ctx.fillRect(0, y, labelW, rowH);
    ctx.fillStyle = '#1c1c20';
    ctx.fillText(tier, labelW / 2, y + rowH / 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3 * u;
    ctx.strokeRect(0, y, W, rowH);

    const items = board.items.filter((it) => it.tier === tier);
    const size = rowH * 0.78;
    const gap = rowH * 0.11;
    let x = labelW + gap * 1.5;
    for (const it of items) {
      let dy = 0;
      let alpha = 1;
      if (it.sceneId) {
        const clip = tl.clips.find((c) => c.scene.id === it.sceneId);
        if (!clip) continue;
        const at = clip.start + 0.12;
        if (t < at) continue;
        const p = clamp01((t - at) / 0.42);
        dy = -(1 - easeOutBounce(p)) * rowH * 1.6;
        alpha = clamp01(p * 3);
      }
      const yy = y + (rowH - size) / 2 + dy;
      ctx.save();
      ctx.globalAlpha = alpha;
      roundRectPath(ctx, x, yy, size, size, size * 0.18);
      ctx.clip();
      const img = assets.image(it.icon);
      if (img && img.naturalWidth) {
        const k = Math.max(size / img.naturalWidth, size / img.naturalHeight);
        const cw = size / k;
        const ch = size / k;
        ctx.drawImage(img, (img.naturalWidth - cw) / 2, (img.naturalHeight - ch) / 2, cw, ch, x, yy, size, size);
      } else {
        ctx.fillStyle = '#3a3a44';
        ctx.fillRect(x, yy, size, size);
        ctx.fillStyle = '#ddd';
        ctx.font = `700 ${Math.round(size * 0.3)}px Inter, "Segoe UI", Arial, sans-serif`;
        ctx.fillText(it.name.slice(0, 2).toUpperCase(), x + size / 2, yy + size / 2);
      }
      ctx.restore();
      x += size + gap;
      if (x + size > W) break;
    }
  });
  ctx.restore();
}

function drawInserts(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, project: Project, tl: Timeline, assets: Assets, layout: FrameLayout) {
  const u = W / 720;
  for (const it of tl.inserts) {
    if (t < it.start || t > it.end + EXIT) continue;
    const enterK = clamp01((t - it.start) / ENTER);
    const exitK = t > it.end ? clamp01(1 - (t - it.end) / EXIT) : 1;
    let scale = 1;
    let alpha = exitK;
    switch (it.insert.motion) {
      case 'pop':
        scale = easeOutBack(enterK);
        break;
      case 'bounce':
        scale = 0.6 + 0.4 * easeOutBounce(enterK);
        break;
      case 'scale':
        scale = 0.9 + 0.1 * easeOutCubic(enterK);
        alpha *= easeOutCubic(enterK);
        break;
      case 'fade':
        alpha *= easeOutCubic(enterK);
        break;
    }
    if (t > it.end) scale *= 0.94 + 0.06 * exitK;

    const img = assets.image(it.insert.image);
    const { x, y, w, h } = insertBox(it.insert, img, W, H, project.aspect);
    layout.inserts.push({ id: it.insert.id, box: { x, y, w, h } });
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-(x + w / 2), -(y + h / 2));
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 24 * u;
    ctx.shadowOffsetY = 8 * u;
    roundRectPath(ctx, x, y, w, h, 16 * u);
    ctx.fillStyle = '#15171c';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.save();
    roundRectPath(ctx, x, y, w, h, 16 * u);
    ctx.clip();
    if (img && img.naturalWidth) ctx.drawImage(img, x, y, w, h);
    else {
      ctx.fillStyle = it.color;
      ctx.globalAlpha = alpha * 0.25;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.round(20 * u)}px Inter, "Segoe UI", Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(it.insert.name || 'Вставка', x + w / 2, y + h / 2);
    }
    ctx.restore();
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    roundRectPath(ctx, x, y, w, h, 16 * u);
    ctx.stroke();
    ctx.restore();
  }
}

function drawCaptions(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, project: Project, tl: Timeline, layout: FrameLayout) {
  const cs = project.style.captions;
  if (!cs.enabled) return;
  const cap = tl.captions.find((c) => t >= c.start && t < c.end);
  if (!cap) return;
  const u = W / 720;
  let fontPx = cs.size * u;
  const family = `${cs.font}, Montserrat, "Arial Black", Impact, sans-serif`;
  const setFont = () => (ctx.font = `900 ${Math.round(fontPx)}px ${family}`);
  setFont();
  const space = fontPx * 0.32;
  const lineH = fontPx * 1.28;
  const text = (s: string) => (cs.uppercase ? s.toUpperCase() : s);
  let widest = 0;
  for (const line of cap.lines) {
    const w = line.reduce((a, wd) => a + ctx.measureText(text(wd.text)).width, 0) + space * (line.length - 1);
    widest = Math.max(widest, w);
  }
  if (widest > W * 0.9) {
    fontPx *= (W * 0.9) / widest;
    setFont();
    widest = W * 0.9;
  }
  const totalH = lineH * cap.lines.length;
  let y = H * cs.y - totalH / 2 + lineH / 2;
  layout.caption = { x: (W - widest) / 2 - space, y: H * cs.y - totalH / 2 - fontPx * 0.2, w: widest + space * 2, h: totalH + fontPx * 0.4 };
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  for (const line of cap.lines) {
    const widths = line.map((wd) => ctx.measureText(text(wd.text)).width);
    const lw = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
    let x = (W - lw) / 2;
    line.forEach((wd, i) => {
      const active = cs.karaoke && t >= wd.start && t < wd.end + 0.04;
      if (active) {
        ctx.fillStyle = cs.highlight;
        roundRectPath(ctx, x - space * 0.45, y - fontPx * 0.62, widths[i] + space * 0.9, fontPx * 1.24, fontPx * 0.22);
        ctx.fill();
      }
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 6 * u;
      ctx.shadowOffsetY = 2 * u;
      ctx.lineWidth = fontPx * 0.16;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.strokeText(text(wd.text), x, y);
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = cs.color;
      ctx.fillText(text(wd.text), x, y);
      x += widths[i] + space;
    });
    y += lineH;
  }
  ctx.restore();
}

function drawGuides(ctx: CanvasRenderingContext2D, W: number, layout: FrameLayout, opts: DrawOptions) {
  const u = W / 720;
  const sel = opts.selectedInsertId ? layout.inserts.find((i) => i.id === opts.selectedInsertId) : null;
  if (sel) {
    const { x, y, w, h } = sel.box;
    ctx.save();
    ctx.setLineDash([8 * u, 6 * u]);
    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = '#22d3ee';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#22d3ee';
    const hs = 14 * u;
    ctx.fillRect(x + w - hs / 2, y + h - hs / 2, hs, hs);
    ctx.restore();
  }
  if (opts.showGuides && layout.caption) {
    const { x, y, w, h } = layout.caption;
    ctx.save();
    ctx.setLineDash([6 * u, 6 * u]);
    ctx.lineWidth = 1.5 * u;
    ctx.strokeStyle = 'rgba(34,211,238,0.6)';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  t: number,
  project: Project,
  tl: Timeline,
  assets: Assets,
  opts: DrawOptions = {},
): FrameLayout {
  const layout: FrameLayout = { inserts: [], caption: null };
  const clip = clipAt(tl, t);
  drawBackground(ctx, W, H, project, clip, assets);
  drawBoard(ctx, W, H, t, project, tl, assets);
  drawInserts(ctx, W, H, t, project, tl, assets, layout);
  drawCaptions(ctx, W, H, t, project, tl, layout);
  if (opts.selectedInsertId || opts.showGuides) drawGuides(ctx, W, layout, opts);
  if (opts.previewLabels && clip?.pendingReplace) drawPendingLabel(ctx, W, project, clip);
  return layout;
}

/** "This piece will be replaced" tag for the preview (never exported). */
function drawPendingLabel(ctx: CanvasRenderingContext2D, W: number, project: Project, clip: ClipTL) {
  const u = W / 720;
  const who = project.characters.find((c) => c.id === clip.scene.speakerId) ?? project.characters[0];
  const text = `Будет заменено${who ? `: ${who.name}` : ''} · дубль ещё не сгенерирован`;
  ctx.save();
  ctx.font = `600 ${Math.round(15 * u)}px Inter, "Segoe UI", Arial, sans-serif`;
  const pad = 10 * u;
  const tw = ctx.measureText(text).width;
  const x = 14 * u;
  const y = 14 * u;
  const h = 30 * u;
  roundRectPath(ctx, x, y, tw + pad * 2, h, 8 * u);
  ctx.fillStyle = 'rgba(139, 92, 246, 0.85)';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + pad, y + h / 2);
  ctx.setLineDash([10 * u, 8 * u]);
  ctx.lineWidth = 3 * u;
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)';
  ctx.strokeRect(1.5 * u, 1.5 * u, W - 3 * u, ctx.canvas.height - 3 * u);
  ctx.restore();
}
