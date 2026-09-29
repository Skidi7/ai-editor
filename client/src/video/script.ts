import type { Insert, Pronunciation, Scene, WordTiming } from './types';

/** Dialogue → display words (punctuation stays attached to its word). Word indices everywhere refer to this list. */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function stripPunct(w: string): string {
  return w
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, '');
}

/** Spoken form of each word: pronunciation overrides replace the word body but keep its trailing punctuation. */
export function spokenWords(tokens: string[], pron: Pronunciation[]): string[] {
  const map = new Map(pron.map((p) => [p.word, p.speech]));
  return tokens.map((t, i) => {
    const s = map.get(i);
    if (!s) return t;
    const trail = /[.,!?;:…»")\]]+$/.exec(t)?.[0] ?? '';
    const lead = /^[«("\[]+/.exec(t)?.[0] ?? '';
    return `${lead}${s}${trail}`;
  });
}

/** The text the presenter is asked to say (what goes into the Seedance prompt and into Whisper alignment). */
export function spokenDialogue(scene: Scene): string {
  return spokenWords(tokenize(scene.dialogue), scene.pronunciations).join(' ');
}

/** ≈ 2.4 words per second plus a beat at both ends; Seedance 2.5 accepts 4–30 s. */
export function estimateDuration(text: string): number {
  const n = tokenize(text).length;
  if (!n) return 5;
  return Math.min(30, Math.max(4, Math.round(n / 2.4 + 1.2)));
}

/** No alignment yet: spread words across the take proportionally to their length. */
export function estimateWordTimings(tokens: string[], duration: number, margins?: { lead: number; tail: number }): WordTiming[] {
  const lead = margins ? Math.min(margins.lead, duration * 0.2) : Math.min(0.5, duration * 0.06);
  const tail = margins ? Math.min(margins.tail, duration * 0.2) : Math.min(0.6, duration * 0.07);
  const speak = Math.max(0.5, duration - lead - tail);
  const weights = tokens.map((t) => stripPunct(t).length + 1.5 + (/[.!?,;:]$/.test(t) ? 1.5 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = lead;
  return weights.map((w) => {
    const d = (speak * w) / total;
    const out = { start: t, end: t + d * 0.92 };
    t += d;
    return out;
  });
}

/**
 * Maps word indices of the old text onto the new text after an edit (LCS on tokens), so inserts,
 * pronunciations and caption breaks survive typo fixes. Deleted words map to null.
 */
export function mapIndices(oldT: string[], newT: string[]): (number | null)[] {
  const n = oldT.length;
  const m = newT.length;
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldT[i] === newT[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const map: (number | null)[] = new Array(n).fill(null);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldT[i] === newT[j]) {
      map[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return map;
}

/** Re-anchors a word range through an index map; falls back to the nearest surviving neighbour. */
export function remapRange(map: (number | null)[], start: number, end: number, newLen: number): [number, number] | null {
  if (!newLen) return null;
  let a: number | null = null;
  let b: number | null = null;
  for (let k = start; k <= end && k < map.length; k++) {
    const v = map[k];
    if (v === null) continue;
    if (a === null) a = v;
    b = v;
  }
  if (a !== null && b !== null) return [a, b];
  // Whole range rewritten: put a one-word marker where the range used to be.
  let prev: number | null = null;
  for (let k = start - 1; k >= 0; k--) {
    if (map[k] !== null) {
      prev = map[k];
      break;
    }
  }
  const pos = Math.min(newLen - 1, prev === null ? 0 : prev + 1);
  return [pos, pos];
}

/** Applies a dialogue edit to a scene and its inserts, keeping every marker attached to its words. */
export function applyDialogueEdit(scene: Scene, inserts: Insert[], newText: string): { scene: Scene; inserts: Insert[] } {
  const oldT = tokenize(scene.dialogue);
  const newT = tokenize(newText);
  const map = mapIndices(oldT, newT);
  const pron = scene.pronunciations
    .map((p) => (map[p.word] === null || map[p.word] === undefined ? null : { ...p, word: map[p.word] as number }))
    .filter((p): p is Pronunciation => !!p);
  const breaks = Array.from(
    new Set(
      scene.captionBreaks
        .map((b) => (map[b] === null || map[b] === undefined ? null : (map[b] as number)))
        .filter((b): b is number => b !== null && b < newT.length - 1),
    ),
  ).sort((a, b) => a - b);
  const nextInserts = inserts
    .map((ins) => {
      if (ins.sceneId !== scene.id) return ins;
      const r = remapRange(map, ins.startWord, ins.endWord, newT.length);
      if (!r) return null;
      return { ...ins, startWord: r[0], endWord: r[1] };
    })
    .filter((x): x is Insert => !!x);
  return {
    scene: {
      ...scene,
      dialogue: newText,
      pronunciations: pron,
      captionBreaks: breaks,
      duration: scene.autoDuration ? estimateDuration(newText) : scene.duration,
    },
    inserts: nextInserts,
  };
}

export interface CaptionWord {
  index: number;
  text: string;
}

/** Splits the words into caption groups: explicit breaks first, then sentence ends, then the size limit. */
export function captionGroups(tokens: string[], breaks: number[], wordsPerLine: number, lines: number): CaptionWord[][] {
  const maxWords = Math.max(1, wordsPerLine * lines);
  const breakSet = new Set(breaks);
  const groups: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
  };
  tokens.forEach((t, i) => {
    cur.push({ index: i, text: t });
    const sentenceEnd = /[.!?…]$/.test(t);
    if (breakSet.has(i) || cur.length >= maxWords || (sentenceEnd && cur.length >= Math.ceil(wordsPerLine / 2))) flush();
  });
  flush();
  return groups;
}

/** Breaks one group into display lines of at most `wordsPerLine` words, balancing the last line. */
export function captionLines(group: CaptionWord[], wordsPerLine: number): CaptionWord[][] {
  const n = group.length;
  const count = Math.max(1, Math.ceil(n / Math.max(1, wordsPerLine)));
  const per = Math.ceil(n / count);
  const out: CaptionWord[][] = [];
  for (let i = 0; i < n; i += per) out.push(group.slice(i, i + per));
  return out;
}

export const INSERT_COLORS = ['#f472b6', '#22d3ee', '#a78bfa', '#fbbf24', '#34d399', '#fb7185', '#60a5fa', '#f97316'];

export function insertColor(index: number): string {
  return INSERT_COLORS[index % INSERT_COLORS.length];
}
