import type { ReactNode } from 'react';
import { IconPause, IconPlay } from '../../editor/Icons';
import { togglePlay, usePlaying } from '../playback';
import type { Gender } from '../types';

/** Warm gradients for women, cool ones for men; the name picks one so twenty voices do not look alike. */
const PALETTES: Record<Gender, [string, string][]> = {
  female: [
    ['#c084fc', '#f472b6'],
    ['#f472b6', '#fb923c'],
    ['#a78bfa', '#ec4899'],
    ['#fb7185', '#f59e0b'],
    ['#e879f9', '#8b5cf6'],
    ['#f9a8d4', '#c084fc'],
    ['#fda4af', '#e11d48'],
    ['#d946ef', '#fb7185'],
  ],
  male: [
    ['#3b82f6', '#22d3ee'],
    ['#6366f1', '#06b6d4'],
    ['#0ea5e9', '#34d399'],
    ['#2563eb', '#818cf8'],
  ],
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Round avatar with initials. */
export function VoiceAvatar({ name, gender, size = 40 }: { name: string; gender: Gender | null; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  const palette = gender ? PALETTES[gender] : null;
  const [a, b] = palette ? palette[hash(name) % palette.length] : ['#4b5370', '#2c3244'];
  return (
    <span className="vc-avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, ${a}, ${b})` }}>
      {initials || '?'}
    </span>
  );
}

/** Round play/stop button backed by the shared player (one sound at a time). */
export function PlayButton({ url, size = 34, title, disabledTitle }: { url: string | null | undefined; size?: number; title?: string; disabledTitle?: string }) {
  const playing = usePlaying(url);
  return (
    <button
      type="button"
      className={`vc-play ${playing ? 'on' : ''}`}
      style={{ width: size, height: size }}
      disabled={!url}
      title={url ? (playing ? 'Stop' : title ?? 'Play') : disabledTitle}
      onClick={(e) => {
        e.stopPropagation();
        if (url) togglePlay(url);
      }}
    >
      {playing ? <IconPause width={size * 0.45} height={size * 0.45} /> : <IconPlay width={size * 0.45} height={size * 0.45} />}
    </button>
  );
}

export function Tags({ items, className }: { items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <span className={`vc-tags ${className ?? ''}`}>
      {items.map((t) => (
        <span key={t} className="vc-tag">
          {t}
        </span>
      ))}
    </span>
  );
}

export function Card({ title, hint, children, right }: { title: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="vc-card">
      <div className="vc-card-head">
        <span className="vc-card-title">{title}</span>
        {hint && <span className="muted small">{hint}</span>}
        <span className="spacer" />
        {right}
      </div>
      {children}
    </section>
  );
}
