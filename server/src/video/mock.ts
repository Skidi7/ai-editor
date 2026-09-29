import { saveBuffer } from './storage.js';

/** Development stand-in for a generated image: an SVG card with the prompt text (drawable on canvas). */
export async function mockImage(prompt: string, aspect: string, label: string): Promise<string> {
  const [aw, ah] = aspect.split(':').map(Number);
  const w = 1024;
  const h = Math.round((w * (ah || 1)) / (aw || 1));
  const hue = Math.abs(hash(prompt)) % 360;
  const words = prompt.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length > 34) {
      lines.push(cur.trim());
      cur = word;
    } else cur += ' ' + word;
    if (lines.length >= 8) break;
  }
  if (cur.trim() && lines.length < 8) lines.push(cur.trim());
  const fs = Math.round(w / 26);
  const text = lines
    .map((l, i) => `<text x="50%" y="${Math.round(h / 2 + (i - (lines.length - 1) / 2) * fs * 1.35)}" font-size="${fs}" text-anchor="middle" fill="#fff" font-family="Segoe UI, Arial, sans-serif">${escape(l)}</text>`)
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,38%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,22%)"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<text x="${fs}" y="${fs * 1.6}" font-size="${Math.round(fs * 0.8)}" fill="rgba(255,255,255,0.7)" font-family="Segoe UI, Arial, sans-serif">${escape(label)} · mock</text>` +
    text +
    `</svg>`;
  const saved = await saveBuffer(Buffer.from(svg, 'utf8'), 'image/svg+xml', 'mock');
  return saved.url;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
