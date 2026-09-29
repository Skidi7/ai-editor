/**
 * Word alignment: matches the script words the presenter was asked to say with the words Whisper heard,
 * and returns a start/end time per script word. Script words that Whisper missed are interpolated between
 * their aligned neighbours, so captions and inserts always get a time even for a sloppy take.
 */

export interface HeardWord {
  word: string;
  start: number;
  end: number;
}
export interface WordTiming {
  start: number;
  end: number;
}

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .replace(/^'+|'+$/g, '');
}

function similar(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.75;
  // Cheap Levenshtein for short words.
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > 3) return 0;
  const prev = new Array(m + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= n; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  const d = prev[m];
  const s = 1 - d / Math.max(n, m);
  return s >= 0.6 ? s * 0.9 : 0;
}

/** Aligns `script` (spoken forms, one entry per displayed word) to `heard`. Returns one timing per script word. */
export function alignWords(script: string[], heard: HeardWord[], totalDuration: number): { words: WordTiming[]; matched: number } {
  const n = script.length;
  const m = heard.length;
  const s = script.map(normalizeWord);
  const h = heard.map((w) => normalizeWord(w.word));
  if (!n) return { words: [], matched: 0 };
  if (!m) return { words: estimateTimings(script, totalDuration), matched: 0 };

  // Needleman-Wunsch global alignment with gap penalties.
  const GAP = -0.4;
  const dp: Float32Array[] = [];
  const bt: Uint8Array[] = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Float32Array(m + 1));
    bt.push(new Uint8Array(m + 1));
  }
  for (let i = 1; i <= n; i++) {
    dp[i][0] = dp[i - 1][0] + GAP;
    bt[i][0] = 1;
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = dp[0][j - 1] + GAP;
    bt[0][j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = similar(s[i - 1], h[j - 1]);
      const match = dp[i - 1][j - 1] + (sim > 0 ? sim : -0.6);
      const up = dp[i - 1][j] + GAP;
      const left = dp[i][j - 1] + GAP;
      if (match >= up && match >= left) {
        dp[i][j] = match;
        bt[i][j] = sim > 0 ? 0 : 3;
      } else if (up >= left) {
        dp[i][j] = up;
        bt[i][j] = 1;
      } else {
        dp[i][j] = left;
        bt[i][j] = 2;
      }
    }
  }
  const map: (number | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const b = bt[i][j];
    if (b === 0 || b === 3) {
      if (b === 0) map[i - 1] = j - 1;
      i--;
      j--;
    } else if (b === 1) i--;
    else j--;
  }

  // Interpolate unmatched script words between matched neighbours.
  const words: WordTiming[] = new Array(n);
  let matched = 0;
  for (let k = 0; k < n; k++) if (map[k] !== null) matched++;
  let k = 0;
  while (k < n) {
    if (map[k] !== null) {
      const hw = heard[map[k]!];
      words[k] = { start: hw.start, end: Math.max(hw.end, hw.start + 0.05) };
      k++;
      continue;
    }
    let e = k;
    while (e < n && map[e] === null) e++;
    const nextHeardStart = e < n ? heard[map[e]!].start : null;
    const prevEnd = k > 0 ? words[k - 1].end : Math.max(0, (nextHeardStart ?? 0) - 0.4 * (e - k));
    const nextStart = nextHeardStart ?? Math.min(totalDuration, prevEnd + 0.35 * (e - k));
    const span = Math.max(0.12 * (e - k), nextStart - prevEnd);
    const weights: number[] = [];
    let total = 0;
    for (let q = k; q < e; q++) {
      const w = s[q].length + 1.5;
      weights.push(w);
      total += w;
    }
    let t = prevEnd;
    for (let q = k; q < e; q++) {
      const d = (span * weights[q - k]) / total;
      words[q] = { start: t, end: t + d };
      t += d;
    }
    k = e;
  }
  // Monotonic clean-up.
  for (let q = 1; q < n; q++) {
    if (words[q].start < words[q - 1].end) words[q].start = words[q - 1].end;
    if (words[q].end < words[q].start + 0.05) words[q].end = words[q].start + 0.05;
  }
  return { words, matched };
}

/** No transcript: spread the words over the take proportionally to their length (same heuristic as the client). */
export function estimateTimings(script: string[], duration: number): WordTiming[] {
  const lead = Math.min(0.5, duration * 0.06);
  const tail = Math.min(0.6, duration * 0.07);
  const speak = Math.max(0.5, duration - lead - tail);
  const weights = script.map((t) => normalizeWord(t).length + 1.5 + (/[.!?,;:]$/.test(t) ? 1.5 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = lead;
  return weights.map((w) => {
    const d = (speak * w) / total;
    const out = { start: t, end: t + d * 0.92 };
    t += d;
    return out;
  });
}

/** True when the payload carries per-word timestamps (as opposed to phrase/segment level). */
export function hasWordLevel(payload: unknown, depth = 0): boolean {
  if (!payload || depth > 6) return false;
  if (Array.isArray(payload)) return payload.some((x) => hasWordLevel(x, depth + 1));
  if (typeof payload !== 'object') return false;
  const o = payload as Record<string, unknown>;
  if ((Array.isArray(o.words) && o.words.length > 0) || (Array.isArray(o.chunks) && o.chunks.length > 0)) return true;
  return Object.values(o).some((v) => v && typeof v === 'object' && hasWordLevel(v, depth + 1));
}

/** Splits a timed segment into words, spreading its span proportionally to word length. */
function segmentToWords(text: string, start: number, end: number): HeardWord[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const weights = words.map((w) => normalizeWord(w).length + 1.5 + (/[.!?,;:]$/.test(w) ? 1 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const span = Math.max(0.05 * words.length, end - start);
  let t = start;
  return words.map((w, i) => {
    const d = (span * weights[i]) / total;
    const out = { word: w, start: t, end: t + d };
    t += d;
    return out;
  });
}

function parseSrtTime(s: string): number {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
}

function parseSrt(srt: string): HeardWord[] {
  const out: HeardWord[] = [];
  for (const block of srt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseSrtTime(a);
    const end = parseSrtTime(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push(...segmentToWords(lines.slice(ti + 1).join(' '), start, end));
  }
  return out;
}

/**
 * Whisper on WaveSpeed returns outputs in slightly different shapes; pull a flat word list out of any of them.
 * True word timestamps (`words: [{word,start,end}]`) are used as-is; segment-level results
 * (`text_details` / `segments` / SRT) are split into words proportionally, so segment boundaries stay exact.
 */
export function parseWhisperWords(payload: unknown): HeardWord[] {
  const out: HeardWord[] = [];
  const push = (word: unknown, start: unknown, end: unknown) => {
    if (typeof word !== 'string' || !word.trim()) return;
    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s)) return;
    out.push({ word: word.trim(), start: s, end: Number.isFinite(e) ? e : s + 0.2 });
  };
  const isSegment = (o: Record<string, unknown>) => typeof o.text === 'string' && o.start !== undefined && o.end !== undefined;
  const visit = (node: unknown, depth = 0): boolean => {
    if (!node || depth > 6) return false;
    if (Array.isArray(node)) {
      // An array of timed segments → words; anything else → recurse.
      if (node.length && node.every((x) => x && typeof x === 'object' && isSegment(x as Record<string, unknown>))) {
        for (const seg of node as Record<string, unknown>[]) out.push(...segmentToWords(String(seg.text), Number(seg.start), Number(seg.end)));
        return true;
      }
      let found = false;
      for (const x of node) found = visit(x, depth + 1) || found;
      return found;
    }
    if (typeof node !== 'object') return false;
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.words) && o.words.length) {
      for (const w of o.words as Record<string, unknown>[]) if (w && typeof w === 'object') push(w.word ?? w.text, w.start, w.end);
      return true;
    }
    if (Array.isArray(o.chunks) && o.chunks.length) {
      for (const c of o.chunks as Record<string, unknown>[]) {
        const ts = c.timestamp as unknown[] | undefined;
        if (Array.isArray(ts)) push(c.text, ts[0], ts[1]);
      }
      return true;
    }
    if (typeof o.word === 'string' && o.start !== undefined) {
      push(o.word, o.start, o.end);
      return true;
    }
    for (const key of ['text_details', 'segments', 'transcription', 'results']) {
      if (Array.isArray(o[key]) && visit(o[key], depth + 1)) return true;
    }
    if (typeof o.srt === 'string' && o.srt.includes('-->')) {
      out.push(...parseSrt(o.srt));
      return true;
    }
    let found = false;
    for (const v of Object.values(o)) if (v && typeof v === 'object') found = visit(v, depth + 1) || found;
    return found;
  };
  visit(payload);
  return out.sort((a, b) => a.start - b.start);
}

// ---------- Source video → scenes ----------

export interface Segment {
  start: number;
  end: number;
  text: string;
  words?: HeardWord[];
}

/** Groups word-level output into phrases: a pause > 0.6 s, a sentence end after 3 s, or 12 s of speech starts a new one. */
function groupWords(words: HeardWord[]): Segment[] {
  const segs: Segment[] = [];
  let cur: HeardWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    segs.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word).join(' '), words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.start - prev.end;
      const len = prev.end - cur[0].start;
      if (gap > 0.6 || (len > 3 && /[.!?…]$/.test(prev.word)) || len > 12) flush();
    }
    cur.push(w);
  }
  flush();
  return segs;
}

/** Segments (phrases with times) out of any Whisper output shape. */
export function parseWhisperSegments(payload: unknown): Segment[] {
  const segs: Segment[] = [];
  const isSeg = (o: Record<string, unknown>) => typeof o.text === 'string' && o.start !== undefined && o.end !== undefined;
  const visit = (node: unknown, depth = 0): boolean => {
    if (!node || depth > 6) return false;
    if (Array.isArray(node)) {
      if (node.length && node.every((x) => x && typeof x === 'object' && isSeg(x as Record<string, unknown>))) {
        for (const s of node as Record<string, unknown>[]) {
          const words = Array.isArray(s.words) ? parseWhisperWords({ words: s.words }) : undefined;
          segs.push({ start: Number(s.start), end: Number(s.end), text: String(s.text).trim(), words: words?.length ? words : undefined });
        }
        return true;
      }
      let found = false;
      for (const x of node) found = visit(x, depth + 1) || found;
      return found;
    }
    if (typeof node !== 'object') return false;
    const o = node as Record<string, unknown>;
    for (const key of ['text_details', 'segments', 'transcription', 'results']) {
      if (Array.isArray(o[key]) && visit(o[key], depth + 1)) return true;
    }
    if ((Array.isArray(o.words) && o.words.length) || (Array.isArray(o.chunks) && o.chunks.length)) {
      segs.push(...groupWords(parseWhisperWords(o)));
      return true;
    }
    if (typeof o.srt === 'string' && o.srt.includes('-->')) {
      segs.push(...groupWords(parseWhisperWords({ srt: o.srt })));
      return true;
    }
    let found = false;
    for (const v of Object.values(o)) if (v && typeof v === 'object') found = visit(v, depth + 1) || found;
    return found;
  };
  visit(payload);
  return segs.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).sort((a, b) => a.start - b.start);
}

function splitSegment(seg: Segment, maxLen: number): Segment[] {
  if (seg.end - seg.start <= maxLen) return [seg];
  const words = seg.words && seg.words.length > 1 ? seg.words : segmentToWords(seg.text, seg.start, seg.end);
  if (words.length < 2) return [seg];
  const mid = (seg.start + seg.end) / 2;
  let cut = words.findIndex((w) => w.start >= mid);
  if (cut <= 0 || cut >= words.length) cut = Math.floor(words.length / 2);
  const a = words.slice(0, cut);
  const b = words.slice(cut);
  const mk = (ws: HeardWord[], start: number, end: number): Segment => ({ start, end, text: ws.map((w) => w.word).join(' '), words: seg.words ? ws : undefined });
  return [...splitSegment(mk(a, seg.start, b[0].start), maxLen), ...splitSegment(mk(b, b[0].start, seg.end), maxLen)];
}

/** Splits a long segment at sentence ends (. ! ? …) using its word timings, keeping every part at least `minPart` long. */
function splitAtSentences(seg: Segment, minPart = 2.5, longerThan = 8): Segment[] {
  if (seg.end - seg.start <= longerThan) return [seg];
  const words = seg.words && seg.words.length > 1 ? seg.words : segmentToWords(seg.text, seg.start, seg.end);
  if (words.length < 4) return [seg];
  const out: Segment[] = [];
  let from = 0;
  let partStart = seg.start;
  for (let i = 0; i < words.length - 1; i++) {
    if (!/[.!?…]["»)]?$/.test(words[i].word)) continue;
    const cut = words[i + 1].start;
    if (cut - partStart < minPart || seg.end - cut < minPart) continue;
    const ws = words.slice(from, i + 1);
    out.push({ start: partStart, end: cut, text: ws.map((w) => w.word).join(' '), words: seg.words ? ws : undefined });
    from = i + 1;
    partStart = cut;
  }
  const rest = words.slice(from);
  out.push({ start: partStart, end: seg.end, text: rest.map((w) => w.word).join(' '), words: seg.words ? rest : undefined });
  return out;
}

/**
 * Makes segments usable as scenes: splits long blobs at sentence ends, fills short gaps, merges fragments
 * shorter than `minLen` into their neighbour, and splits anything longer than `maxLen` (Seedance takes are 4–30 s)
 * at word boundaries.
 */
export function normalizeSegments(input: Segment[], duration?: number, minLen = 1.2, maxLen = 30): Segment[] {
  let segs = input
    .map((s) => ({ ...s, text: s.text.trim() }))
    .filter((s) => s.text)
    .flatMap((s) => splitAtSentences(s));
  if (!segs.length) return [];
  for (let i = 0; i < segs.length - 1; i++) {
    const gap = segs[i + 1].start - segs[i].end;
    if (gap > 0 && gap < 0.8) segs[i].end = segs[i + 1].start;
  }
  if (segs[0].start < 0.4) segs[0].start = 0;
  if (duration && duration - segs[segs.length - 1].end < 0.8) segs[segs.length - 1].end = duration;
  const merged: Segment[] = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    const tooShort = s.end - s.start < minLen || s.text.split(/\s+/).length < 2;
    if (prev && tooShort && prev.end - prev.start + (s.end - s.start) <= maxLen) {
      prev.end = s.end;
      prev.text = `${prev.text} ${s.text}`;
      prev.words = prev.words && s.words ? prev.words.concat(s.words) : undefined;
    } else merged.push({ ...s });
  }
  segs = merged.flatMap((s) => splitSegment(s, maxLen));
  return segs.map((s) => ({ ...s, start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100 }));
}
