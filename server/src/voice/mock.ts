/**
 * Mock-mode audio: without a WaveSpeed key (or with VOICE_PROVIDER=mock) every generation returns a synthetic
 * "babble" WAV instead of calling a model, so the whole UI can be exercised for free. The babble follows the text
 * (a syllable per vowel, pauses on punctuation) and its pitch depends on the voice, so different voices sound different.
 */

const SAMPLE_RATE = 24000;

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

/** Rough vowel formants (F1, F2) so the babble sounds like speech rather than a beep. */
const FORMANTS: Record<string, [number, number]> = {
  а: [750, 1300], a: [750, 1300], я: [700, 1500],
  о: [500, 900], o: [500, 900], ё: [500, 1000],
  у: [320, 800], u: [320, 800], ю: [330, 1100],
  э: [550, 1800], е: [450, 2000], e: [450, 2000],
  и: [300, 2300], i: [300, 2300], ы: [350, 1600], y: [350, 1600],
};

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Base pitch for a voice from its gender / age group (mock only). */
export function mockPitch(gender: string | null | undefined, age: string | null | undefined, key = ''): number {
  const f0 = (gender === 'male' ? 118 : 205) * (age === 'young' ? 1.06 : age === 'mature' ? 0.95 : 1);
  return f0 * (0.9 + (hashString(key) % 200) / 1000);
}

export function babbleWav(text: string, opts: { f0: number; speed?: number; seed?: string }): Buffer {
  const sr = SAMPLE_RATE;
  const speed = Math.min(4, Math.max(0.25, opts.speed ?? 1));
  const rand = rng(hashString(`${opts.seed ?? ''}|${text}`));
  const chunks: Float32Array[] = [];
  const silence = (sec: number) => chunks.push(new Float32Array(Math.round((sec / speed) * sr)));

  const syllable = (vowel: string, f0: number) => {
    const [f1, f2] = FORMANTS[vowel] ?? [600, 1500];
    const consonant = Math.round(((0.025 + rand() * 0.02) / speed) * sr);
    const voiced = Math.round(((0.11 + rand() * 0.07) / speed) * sr);
    const out = new Float32Array(consonant + voiced);
    for (let i = 0; i < consonant; i++) out[i] = (rand() * 2 - 1) * 0.12 * Math.sin((Math.PI * i) / consonant);
    const phases = new Float64Array(10);
    const attack = Math.round(0.018 * sr);
    const release = Math.round(0.045 * sr);
    for (let i = 0; i < voiced; i++) {
      const t = i / sr;
      const f = f0 * (1 + 0.035 * Math.sin(2 * Math.PI * 5.5 * t)) * (1 - 0.12 * (i / voiced));
      let s = 0;
      for (let k = 1; k <= 10; k++) {
        const h = k * f;
        if (h > sr / 2 - 500) break;
        phases[k - 1] += (2 * Math.PI * h) / sr;
        const gain = Math.exp(-(((h - f1) / 180) ** 2)) + 0.6 * Math.exp(-(((h - f2) / 260) ** 2)) + 0.04;
        s += (gain / k ** 0.6) * Math.sin(phases[k - 1]);
      }
      const env = Math.min(1, i / attack, (voiced - i) / release);
      out[consonant + i] = s * 0.3 * env;
    }
    chunks.push(out);
  };

  silence(0.15);
  const tokens = text.match(/[\p{L}\p{N}]+|[.,!?;:…—-]/gu) ?? [];
  let phrasePos = 0;
  for (const tok of tokens) {
    if (/^[.!?…]$/.test(tok)) {
      silence(0.35);
      phrasePos = 0;
      continue;
    }
    if (/^[,;:—-]$/.test(tok)) {
      silence(0.18);
      continue;
    }
    const vowels = tok.toLowerCase().match(/[аеёиоуыэюяaeiouy]/g) ?? ['а'];
    for (const v of vowels) {
      // Gentle declination over a phrase plus a little randomness per syllable.
      const f = opts.f0 * (1.08 - Math.min(0.2, phrasePos * 0.012)) * (0.94 + rand() * 0.12);
      syllable(v, f);
      phrasePos += 1;
    }
    silence(0.06);
  }
  silence(0.2);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  let peak = 0.001;
  for (const c of chunks) {
    pcm.set(c, off);
    off += c.length;
  }
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const k = 0.6 / peak;
  for (let i = 0; i < total; i++) pcm[i] *= k;
  return encodeWav(pcm, sr);
}
