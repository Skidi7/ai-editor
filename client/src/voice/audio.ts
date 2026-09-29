/**
 * Browser-side audio: decoding audio and video files, finding a good speech fragment, cutting it to WAV,
 * merging multi-part speech and recording from the microphone. Everything runs at 24 kHz mono, which is plenty
 * for voice and keeps a 10-minute video's decoded track small.
 */

export const SAMPLE_RATE = 24000;

/** Decodes any file the browser can play (MP3/WAV/M4A/OGG, MP4/WebM/MOV video) into 24 kHz audio. */
export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  // OfflineAudioContext decodes without user activation and resamples to its own rate.
  return new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(data);
}

export async function decodeUrl(url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the audio (${res.status})`);
  return decodeAudio(await res.arrayBuffer());
}

export function toMono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i];
  }
  const k = 1 / buf.numberOfChannels;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

export function peakOf(mono: Float32Array, from = 0, to = mono.length): number {
  let p = 0;
  for (let i = from; i < to; i++) {
    const v = Math.abs(mono[i]);
    if (v > p) p = v;
  }
  return p;
}

const FRAME = 0.05;

function frameRms(mono: Float32Array, sr: number): Float32Array {
  const hop = Math.round(sr * FRAME);
  const n = Math.floor(mono.length / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 0; i < hop; i++) s += mono[o + i] * mono[o + i];
    out[f] = Math.sqrt(s / hop);
  }
  return out;
}

/**
 * Speech per 50 ms frame: loud enough relative to the file's own level AND with a jumpy loudness around it. Speech
 * rises and falls with every syllable, while music, a hum or a held note stays flat, so flat loud stretches are not
 * mistaken for talking (falls back to loudness alone when nothing in the file moves like speech).
 */
function voicedFrames(mono: Float32Array, sr: number): Uint8Array {
  const rms = frameRms(mono, sr);
  const n = rms.length;
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const thr = Math.max(q(0.2) * 2.5, q(0.9) * 0.22, 0.004);
  const db = Float32Array.from(rms, (v) => 20 * Math.log10(v + 1e-6));
  const out = new Uint8Array(n);
  let speechy = 0;
  for (let i = 0; i < n; i++) {
    if (rms[i] <= thr) continue;
    let s = 0;
    let s2 = 0;
    let c = 0;
    for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) {
      s += db[j];
      s2 += db[j] * db[j];
      c++;
    }
    if (Math.sqrt(Math.max(0, s2 / c - (s / c) ** 2)) > 3) {
      out[i] = 1;
      speechy++;
    }
  }
  if (speechy < n * 0.05) return Uint8Array.from(rms, (v) => (v > thr ? 1 : 0));
  return out;
}

/**
 * Keeps only the stretches where the transcript says words are spoken (Whisper timestamps), with small margins and
 * short gaps between them. Music, noise or a second sound around the speech would otherwise count as "speaking time".
 */
export function keepPhrases(x: Float32Array, sr: number, phrases: { start: number; end: number }[]): Float32Array {
  const dur = x.length / sr;
  const spans = phrases
    .map((p) => [Math.max(0, p.start - 0.08), Math.min(dur, p.end + 0.15)] as [number, number])
    .filter(([a, b]) => b - a > 0.2)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 0.3) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  if (!merged.length) return x;
  const gap = Math.round(sr * 0.25);
  const parts = merged.map(([a, b]) => x.slice(Math.floor(a * sr), Math.ceil(b * sr)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0) + gap * (parts.length - 1));
  const fade = Math.round(sr * 0.01);
  let off = 0;
  for (const p of parts) {
    for (let i = 0; i < fade && i < p.length / 2; i++) {
      const k = i / fade;
      p[i] *= k;
      p[p.length - 1 - i] *= k;
    }
    out.set(p, off);
    off += p.length + gap;
  }
  return out;
}

/**
 * Picks the best reference fragment: the window of ~`target` seconds with the most speech, with its edges moved
 * into nearby pauses so no word is cut. Short files just lose their leading and trailing silence.
 */
export function bestFragment(mono: Float32Array, sr: number, target = 10, max = 15): { start: number; end: number } {
  const duration = mono.length / sr;
  const voiced = voicedFrames(mono, sr);
  const n = voiced.length;
  if (!n) return { start: 0, end: duration };
  const first = voiced.indexOf(1);
  const last = voiced.lastIndexOf(1);
  if (first < 0) return { start: 0, end: Math.min(duration, target) };
  if ((last - first + 1) * FRAME <= max) {
    return { start: Math.max(0, first * FRAME - 0.15), end: Math.min(duration, (last + 1) * FRAME + 0.2) };
  }
  const win = Math.round(target / FRAME);
  const prefix = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + voiced[i];
  let bestStart = first;
  let bestScore = -1;
  for (let s = first; s + win <= n; s += 2) {
    const score = prefix[s + win] - prefix[s];
    if (score > bestScore) {
      bestScore = score;
      bestStart = s;
    }
  }
  // Edges into pauses: search up to 1 s outward (and a little inward) for a silent frame.
  const quietNear = (idx: number, outward: -1 | 1) => {
    for (let d = 0; d <= 20; d++) {
      const out = idx + d * outward;
      if (out >= 0 && out < n && !voiced[out]) return out;
      const inw = idx - d * outward;
      if (d <= 6 && inw >= 0 && inw < n && !voiced[inw]) return inw;
    }
    return idx;
  };
  const s = quietNear(bestStart, -1);
  const e = quietNear(Math.min(n - 1, bestStart + win), 1);
  let start = s * FRAME;
  let end = Math.min(duration, (e + 1) * FRAME);
  if (end - start > max + 2) end = start + max;
  if (end - start < 3) end = Math.min(duration, start + target);
  return { start, end };
}

/** Samples of [start, end] with 10 ms fades, gently raised when the recording is very quiet. */
export function cutFragment(mono: Float32Array, sr: number, start: number, end: number): Float32Array {
  const a = Math.max(0, Math.floor(start * sr));
  const b = Math.min(mono.length, Math.ceil(end * sr));
  const out = mono.slice(a, b);
  const fade = Math.min(Math.round(sr * 0.01), Math.floor(out.length / 2));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i] *= k;
    out[out.length - 1 - i] *= k;
  }
  const peak = peakOf(out);
  if (peak > 0 && peak < 0.3) {
    const gain = Math.min(6, 0.85 / peak);
    for (let i = 0; i < out.length; i++) out[i] *= gain;
  }
  return out;
}

/**
 * Shortens long pauses inside a speech clip and trims silence at its ends. OmniVoice sizes the new speech by the
 * reference's seconds-per-character, so a sample full of pauses makes every generated phrase slow and stretched.
 */
export function tightenPauses(x: Float32Array, sr: number, maxPause = 0.3): Float32Array {
  const hop = Math.round(sr * 0.02);
  const n = Math.floor(x.length / hop);
  if (n < 10) return x;
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += x[i] * x[i];
    rms[f] = Math.sqrt(s / hop);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const loud = sorted[Math.floor(n * 0.9)];
  // -26 dB under the loud parts: quiet word endings still count as speech.
  const thr = Math.max(loud * 0.05, 0.002);
  const voiced = Array.from(rms, (v) => v > thr);
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  if (first < 0) return x;
  const keep = Math.round(maxPause / 0.02 / 2);
  const pieces: [number, number][] = [];
  let start = Math.max(0, first - 5);
  let f = first;
  while (f <= last) {
    if (voiced[f]) {
      f++;
      continue;
    }
    let g = f;
    while (g <= last && !voiced[g]) g++;
    if (g - f > keep * 2) {
      pieces.push([start, f + keep]);
      start = g - keep;
    }
    f = g;
  }
  pieces.push([start, Math.min(n, last + 12)]);
  const total = pieces.reduce((sum, [a, b]) => sum + (b - a) * hop, 0);
  const out = new Float32Array(total);
  const fade = Math.round(sr * 0.005);
  let off = 0;
  for (const [a, b] of pieces) {
    const seg = x.subarray(a * hop, b * hop);
    out.set(seg, off);
    // Short fades at every joint so the cuts do not click.
    for (let i = 0; i < fade && i < seg.length / 2; i++) {
      const k = i / fade;
      out[off + i] *= k;
      out[off + seg.length - 1 - i] *= k;
    }
    off += seg.length;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sr = SAMPLE_RATE): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Joins the parts of a long text into one WAV with short pauses between them. */
export async function mergeClips(urls: string[], gapSec = 0.3): Promise<{ blob: Blob; duration: number }> {
  const parts = await Promise.all(urls.map(async (u) => toMono(await decodeUrl(u))));
  const gap = Math.round(gapSec * SAMPLE_RATE);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * (parts.length - 1);
  const out = new Float32Array(total);
  let off = 0;
  parts.forEach((p, i) => {
    out.set(p, off);
    off += p.length + (i < parts.length - 1 ? gap : 0);
  });
  return { blob: encodeWav(out, SAMPLE_RATE), duration: total / SAMPLE_RATE };
}

/** Max |amplitude| per column for drawing a waveform of [from, to) samples. */
export function columnPeaks(mono: Float32Array, from: number, to: number, columns: number): Float32Array {
  const out = new Float32Array(columns);
  const span = Math.max(1, to - from);
  for (let c = 0; c < columns; c++) {
    const a = from + Math.floor((c * span) / columns);
    const b = Math.max(a + 1, from + Math.floor(((c + 1) * span) / columns));
    // Long ranges: sample every few points; the drawing is a few hundred pixels wide anyway.
    const step = Math.max(1, Math.floor((b - a) / 400));
    let p = 0;
    for (let i = a; i < b && i < mono.length; i += step) {
      const v = Math.abs(mono[i]);
      if (v > p) p = v;
    }
    out[c] = p;
  }
  return out;
}

export function audioDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    const done = (v: number | null) => {
      a.removeAttribute('src');
      resolve(v);
    };
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => done(null);
    window.setTimeout(() => done(null), 8000);
    a.src = url;
  });
}

/** Plays [start, end] of a decoded buffer; reports the playhead. */
export class RangePlayer {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private raf = 0;

  play(buffer: AudioBuffer, start: number, end: number, onTime: (t: number | null) => void) {
    this.stop();
    const ctx = this.ctx ?? (this.ctx = new AudioContext());
    void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const t0 = ctx.currentTime;
    src.start(0, start, Math.max(0.05, end - start));
    src.onended = () => {
      if (this.src === src) this.stop(onTime);
    };
    this.src = src;
    const tick = () => {
      onTime(Math.min(end, start + (ctx.currentTime - t0)));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(onTime?: (t: number | null) => void) {
    cancelAnimationFrame(this.raf);
    if (this.src) {
      const s = this.src;
      this.src = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    onTime?.(null);
  }

  get playing() {
    return !!this.src;
  }
}

/** Microphone recording with a live level meter. */
export class MicRecorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private data = new Float32Array(1024);

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not allow microphone access');
    // No echo cancellation / auto gain: they colour the timbre; noise suppression helps more than it hurts.
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: true } });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(250);
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
  }

  /** 0..1 loudness for the meter. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    let s = 0;
    for (const v of this.data) s += v * v;
    return Math.min(1, Math.sqrt(s / this.data.length) * 4);
  }

  stop(): Promise<Blob> {
    const rec = this.rec;
    if (!rec) return Promise.reject(new Error('Not recording'));
    return new Promise((resolve) => {
      rec.onstop = () => {
        const type = (rec.mimeType || 'audio/webm').split(';')[0];
        this.cleanup();
        resolve(new Blob(this.chunks, { type }));
      };
      rec.stop();
    });
  }

  cancel() {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.cleanup();
  }

  private cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.rec = null;
    this.ctx = null;
    this.analyser = null;
  }
}
