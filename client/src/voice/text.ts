import { DEFAULT_PRICES, type VoicePrices } from './types';

/**
 * Text helpers: which language the text is written in (shown to the user; OmniVoice picks the language from the
 * text itself), splitting long texts into requests, and price / duration estimates.
 */

export interface LangInfo {
  code: string;
  label: string;
}

const LABELS: Record<string, string> = {
  en: 'English',
  zh: 'Chinese',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  es: 'Spanish',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  ru: 'Russian',
  uk: 'Ukrainian',
  be: 'Belarusian',
  kk: 'Kazakh',
  pl: 'Polish',
  nl: 'Dutch',
  tr: 'Turkish',
  vi: 'Vietnamese',
  ar: 'Arabic',
  he: 'Hebrew',
  hi: 'Hindi',
  el: 'Greek',
  th: 'Thai',
  ka: 'Georgian',
  hy: 'Armenian',
};

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'are', 'you', 'to', 'of', 'in', 'it', 'that', 'this', 'with', 'for', 'was', 'have', 'what', 'my'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'sie', 'mit', 'ein', 'eine', 'zu', 'auf', 'für', 'auch', 'wir', 'es'],
  fr: ['le', 'la', 'les', 'et', 'est', 'un', 'une', 'des', 'du', 'de', 'au', 'que', 'pas', 'pour', 'dans', 'avec', 'vous', 'je', 'qui', 'sur', 'nous', 'ce', 'ceci'],
  es: ['el', 'los', 'las', 'y', 'es', 'que', 'un', 'una', 'de', 'por', 'para', 'con', 'no', 'está', 'pero', 'muy', 'del', 'como', 'yo'],
  it: ['il', 'lo', 'la', 'gli', 'e', 'è', 'che', 'un', 'una', 'per', 'con', 'non', 'sono', 'della', 'questo', 'questa', 'ma', 'anche', 'di', 'mi', 'mia', 'mio', 'ogni', 'molto', 'ciao'],
  pt: ['o', 'os', 'as', 'e', 'é', 'que', 'um', 'uma', 'de', 'não', 'para', 'com', 'você', 'está', 'esta', 'muito', 'do', 'da', 'eu', 'minha', 'ela', 'numa', 'olá'],
  pl: ['i', 'w', 'z', 'na', 'się', 'nie', 'to', 'jest', 'że', 'do', 'jak', 'ale', 'co', 'tak'],
  nl: ['de', 'het', 'een', 'en', 'is', 'niet', 'van', 'ik', 'je', 'dat', 'met', 'voor', 'zijn', 'wat'],
  tr: ['bir', 've', 'bu', 'için', 'ile', 'çok', 'değil', 'ne', 'ama', 'ben', 'sen', 'da', 'de'],
};

const DIACRITICS: [string, RegExp][] = [
  ['vi', /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ]/gi],
  ['de', /[äöüß]/gi],
  ['es', /[ñ¿¡]/gi],
  ['pt', /[ãõç]/gi],
  ['pl', /[ąćęłńśźż]/gi],
  ['tr', /[ğış]/gi],
  ['fr', /[âçêëîïôûœ]/gi],
  ['it', /[ìò]/gi],
];

export function detectLanguage(text: string): LangInfo | null {
  const t = text.slice(0, 3000);
  const count = (re: RegExp) => (t.match(re) || []).length;
  const scripts: [string, number][] = [
    ['cyr', count(/[Ѐ-ӿ]/g)],
    ['lat', count(/[A-Za-zÀ-ɏḀ-ỿ]/g)],
    ['han', count(/[一-鿿]/g)],
    ['kana', count(/[぀-ヿ]/g)],
    ['ko', count(/[가-힯ᄀ-ᇿ]/g)],
    ['ar', count(/[؀-ۿ]/g)],
    ['he', count(/[֐-׿]/g)],
    ['hi', count(/[ऀ-ॿ]/g)],
    ['el', count(/[Ͱ-Ͽ]/g)],
    ['th', count(/[฀-๿]/g)],
    ['ka', count(/[Ⴀ-ჿ]/g)],
    ['hy', count(/[԰-֏]/g)],
  ];
  const total = scripts.reduce((s, [, n]) => s + n, 0);
  if (total < 3) return null;
  const kana = scripts.find(([s]) => s === 'kana')![1];
  let [top] = scripts.reduce((a, b) => (b[1] > a[1] ? b : a));
  // Japanese mixes kanji with kana; Chinese has no kana at all.
  const han = scripts.find(([s]) => s === 'han')![1];
  // Hiragana (grammar words) marks Japanese; a katakana loanword alone does not make Chinese text Japanese.
  const hiragana = count(/[぀-ゟ]/g);
  if (top === 'kana' || (top === 'han' && hiragana >= Math.max(2, (kana + han) * 0.05))) top = 'ja';
  else if (top === 'han') top = 'zh';
  let code = top;
  if (top === 'cyr') {
    if (/[әғқңөұүһ]/i.test(t)) code = 'kk';
    else if (/[ў]/i.test(t)) code = 'be';
    else if (/[іїєґ]/i.test(t)) code = 'uk';
    else code = 'ru';
  } else if (top === 'lat') {
    const words = t.toLowerCase().match(/[\p{L}']+/gu) ?? [];
    const score: Record<string, number> = {};
    for (const [lang, list] of Object.entries(STOPWORDS)) {
      const set = new Set(list);
      score[lang] = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    }
    for (const [lang, re] of DIACRITICS) score[lang] = (score[lang] ?? 0) + count(re) * 1.5;
    const best = Object.entries(score).reduce((a, b) => (b[1] > a[1] ? b : a), ['en', 0] as [string, number]);
    code = best[1] > 0 ? best[0] : 'en';
  }
  return { code, label: LABELS[code] ?? code };
}

/** Where an over-long sentence may be cut: after a space or a comma-like mark (Latin or CJK). */
const SOFT_BREAK = /[\s,;:，、；：]/;

/** Ends of sentences in the text itself (index right after each sentence and its trailing spaces). */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  // Intl.Segmenter is newer than the ES2020 typings used here.
  type Segmenter = new (locale: undefined, options: { granularity: 'sentence' }) => { segment(text: string): Iterable<{ index: number; segment: string }> };
  const Segmenter = (Intl as unknown as { Segmenter?: Segmenter }).Segmenter;
  if (Segmenter) {
    for (const s of new Segmenter(undefined, { granularity: 'sentence' }).segment(text)) ends.push(s.index + s.segment.length);
  } else {
    // Fallback: . ! ? … followed by a space or the end (so "4.99" or "example.com" never split), CJK marks, line breaks.
    const re = /[.!?…]+["»”')\]]*(?=\s|$)\s*|[。！？]+\s*|\n+/g;
    for (let m = re.exec(text); m; m = re.exec(text)) ends.push(m.index + m[0].length);
  }
  if (ends[ends.length - 1] !== text.length) ends.push(text.length);
  return ends;
}

/**
 * Splits a long text into requests of at most `max` characters, on sentence boundaries (then spaces / commas, then a
 * hard cut). Every request is a slice of the original text — nothing is added or removed, so "$4.99", "example.com"
 * and line breaks stay as written. A request under 100 characters costs as much as 100, so a short tail is merged or
 * balanced with the one before it.
 */
export function splitText(text: string, max = 600): string[] {
  const src = text.replace(/\r\n?/g, '\n');
  const whole = src.trim();
  if (!whole) return [];
  if (whole.length <= max) return [whole];
  const size = (a: number, b: number) => src.slice(a, b).trim().length;

  const pieces: [number, number][] = [];
  let start = 0;
  for (const end of sentenceEnds(src)) {
    let a = start;
    while (end - a > max) {
      // An over-long sentence is cut into equal parts at the soft break nearest each target, never over `max`.
      const target = a + Math.ceil((end - a) / Math.ceil((end - a) / max));
      let cut = -1;
      for (let d = 0; d <= max * 0.4 && cut < 0; d++) {
        for (const i of [target - d, target + d]) {
          if (i > a && i <= a + max && i < end && SOFT_BREAK.test(src[i - 1])) {
            cut = i;
            break;
          }
        }
      }
      if (cut < 0) cut = Math.min(a + max, target);
      // Never split an emoji or a rare character (a surrogate pair) in two.
      if (/[\uD800-\uDBFF]/.test(src[cut - 1] ?? '')) cut -= 1;
      pieces.push([a, cut]);
      a = cut;
    }
    if (end > a) pieces.push([a, end]);
    start = end;
  }

  const chunks: [number, number][] = [];
  for (const p of pieces) {
    const last = chunks[chunks.length - 1];
    if (last && size(last[0], p[1]) <= max) last[1] = p[1];
    else chunks.push([p[0], p[1]]);
  }

  if (chunks.length > 1) {
    const prev = chunks[chunks.length - 2];
    const tail = chunks[chunks.length - 1];
    if (size(tail[0], tail[1]) < 100) {
      if (size(prev[0], tail[1]) <= max) {
        chunks.splice(-2, 2, [prev[0], tail[1]]);
      } else {
        // Move the boundary between the last two requests to the piece edge nearest their middle.
        const mid = (prev[0] + tail[1]) / 2;
        let best = prev[1];
        for (const [, e] of pieces) {
          if (e <= prev[0] || e >= tail[1]) continue;
          if (size(prev[0], e) <= max && size(e, tail[1]) <= max && Math.abs(e - mid) < Math.abs(best - mid)) best = e;
        }
        prev[1] = best;
        tail[0] = best;
      }
    }
  }
  // A request without a single word (emoji, a line of dashes) would be refused and sink the whole text after the
  // parts before it were paid: glue it to a neighbour when that stays near `max`, otherwise drop it (nothing to say).
  for (let i = chunks.length - 1; i >= 0 && chunks.length > 1; i--) {
    const [a, b] = chunks[i];
    if (hasWords(src.slice(a, b))) continue;
    if (i > 0 && size(chunks[i - 1][0], b) <= max + 100) chunks[i - 1][1] = b;
    else if (i === 0 && size(a, chunks[1][1]) <= max + 100) chunks[1][0] = a;
    chunks.splice(i, 1);
  }
  return chunks.map(([a, b]) => src.slice(a, b).trim()).filter(Boolean);
}

export function omniPrice(chars: number, p: VoicePrices = DEFAULT_PRICES): number {
  return chars < 100 ? p.omniFlat : chars * p.omniPerChar;
}

export function qwenPrice(chars: number, p: VoicePrices = DEFAULT_PRICES): number {
  return Math.max(p.qwenPer100, (chars / 100) * p.qwenPer100);
}

export function perSecond(seconds: number, rate: number): number {
  return Math.max(1, Math.ceil(seconds)) * rate;
}

/** Price of voicing a text: one OmniVoice request per chunk. */
export function speakCost(text: string, p: VoicePrices = DEFAULT_PRICES): number {
  return splitText(text).reduce((sum, c) => sum + omniPrice(c.length, p), 0);
}

/** Rough speech length: ~14 characters per second, ~5 for Chinese / Japanese / Korean characters. */
export function estimateSeconds(text: string, speed = 1): number {
  const t = text.trim();
  const cjk = (t.match(/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g) || []).length;
  return ((t.length - cjk) / 14 + cjk / 5) / (speed || 1);
}

/** Something a voice can say: at least one letter or digit (punctuation or emoji alone would be a paid silence). */
export function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export function formatSeconds(s: number): string {
  if (!Number.isFinite(s)) return '—';
  if (s < 9.95) return `${s.toFixed(1)} s`;
  const r = Math.round(s);
  if (r < 60) return `${r} s`;
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
}

export function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
