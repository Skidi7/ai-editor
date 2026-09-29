import { wavespeedRunRaw } from '../providers/wavespeed.js';
import { fetchRetry } from '../util.js';
import { ADULT_ONLY, PRESETS, type AgeGroup, type Gender } from './presets.js';

/**
 * "Create a voice from a description". The user writes in plain words, in any language; Qwen3 Voice Design wants an
 * English description. An LLM on WaveSpeed (any-llm, ~$0.001) turns the request into one, suggests a name and tags,
 * picks the language of the sample phrase and writes the phrase in character. Without the LLM (mock mode or an LLM
 * error) the user's words go to the model as they are, after the rules below.
 */

export interface VoiceSpec {
  /** English description for Qwen3 Voice Design. */
  description: string;
  name: string;
  gender: Gender | null;
  age: AgeGroup | null;
  timbre: string[];
  manner: string[];
  /** Phrase the new voice says in its sample clip. */
  sample: string;
  /** Language of the phrase: a QWEN_LANGS key. */
  language: string;
  via: 'llm' | 'rules';
}

/** Languages Qwen3 Voice Design speaks (API values), English first. */
export const QWEN_LANGS: Record<string, string> = {
  en: 'English',
  zh: 'Chinese',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  es: 'Spanish',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
};

const DEFAULT_SAMPLE = "Hi there! This is my new voice. Listen to how it sounds when I just talk, like we're having a normal conversation.";

/** Cuts a phrase to `max` characters at the end of a sentence (or a word), never mid-word. */
function clipPhrase(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end > max * 0.4) return head.slice(0, end + 1);
  return head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : max).trim();
}

function guessGender(request: string): Gender | null {
  const female = /\b(woman|women|female|girl|lady|she|her)\b|женщин|девушк|женск/i.test(request);
  const male = /\b(man|men|male|guy|he|his)\b|мужчин|парен|мужск/i.test(request);
  return female === male ? null : female ? 'female' : 'male';
}

/** Rule-based spec: used in mock mode and whenever the LLM is unavailable. */
export function ruleSpec(request: string): VoiceSpec {
  // Without the LLM the user's words go to the model as they are: drop ages under 18 and child words first.
  const notes = request
    .replace(/\b(1[0-7]|[1-9])\s*(-|\s)?\s*(years?\s*old|y\/?o|yo)\b/gi, '')
    .replace(/\b(little\s+)?(girl|boy|kid|child|toddler|baby|teen(ager)?)s?\b/gi, 'adult')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([^.!?])$/, '$1.');
  return {
    description: `${notes || 'A natural, pleasant voice with a friendly, conversational delivery.'} ${ADULT_ONLY}`,
    name: '',
    gender: guessGender(request),
    age: null,
    timbre: [],
    manner: [],
    sample: DEFAULT_SAMPLE,
    language: 'en',
    via: 'rules',
  };
}

const SYSTEM_PROMPT = `You are a voice-casting assistant for a text-to-speech voice designer.
The user describes the voice they want, in any language. Reply with ONE JSON object and nothing else:
{
  "description": "English description for the voice-design model, 2-3 short sentences: gender, approximate age, pitch and timbre, accent if any, emotional tone, speaking pace and style. Use concrete acoustic words (husky, breathy, resonant, nasal, crisp diction, vocal fry...). No names of people, brands or characters.",
  "name": "a short English first name or nickname that suits the character",
  "gender": "female" | "male" | null,
  "age": "young" | "adult" | "mature" | null,
  "timbre": ["1-3 short English adjectives about the sound of the voice, e.g. velvety, husky, bright"],
  "manner": ["1-3 short English words about the way of speaking, e.g. calm, ironic, whispery"],
  "language": "language of the sample sentence, one of: ${Object.values(QWEN_LANGS).join(', ')}. English, unless the request says the voice speaks one of the others",
  "sample": "1-2 natural sentences in that language, 90-140 characters in total, that this character would plausibly say, showing their mood, manner and accent. Plain text only: no quotes, emojis or stage directions."
}
Age groups: young 18-24, adult 25-32, mature 33-40. The product only has adult voices aged 18 to 40: if the request
describes a child, a teenager or an older person, design the closest voice within 18-40 instead.
Aim for a natural, human voice with real emotion and unforced pauses, never robotic or announcer-like.
If the request names a real person (celebrity, politician, etc.), do not imitate them: describe only generic vocal qualities.`;

function extractJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('LLM returned no JSON');
  return JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>;
}

async function llmText(outputs: unknown[]): Promise<string> {
  const out = outputs[0];
  if (typeof out === 'string') {
    if (/^https?:\/\//.test(out)) {
      const res = await fetchRetry(out, undefined, 3, 'download LLM output');
      return res.text();
    }
    return out;
  }
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    const t = o.text ?? o.content ?? o.output;
    if (typeof t === 'string') return t;
  }
  throw new Error(`Unexpected LLM output: ${JSON.stringify(out).slice(0, 200)}`);
}

const words = (v: unknown) =>
  Array.isArray(v)
    ? v
        .map((x) => String(x).trim().toLowerCase())
        .filter((x) => x && x.length <= 24)
        .slice(0, 3)
    : [];

const GENDERS = new Set(['female', 'male']);
const AGES = new Set(['young', 'adult', 'mature']);

/** Request → spec via WaveSpeed any-llm. Throws on any problem so the caller can fall back to ruleSpec. */
export async function llmSpec(request: string): Promise<VoiceSpec> {
  const prompt = [`Voice request: ${request.trim()}`, `Names already taken in the library (pick another): ${PRESETS.map((p) => p.name).join(', ')}`].join('\n');
  const outputs = await wavespeedRunRaw(
    process.env.WAVESPEED_LLM_MODEL || 'wavespeed-ai/any-llm',
    { prompt, system_prompt: SYSTEM_PROMPT, model: process.env.VOICE_LLM || 'google/gemini-2.5-flash', temperature: 0.7, max_tokens: 800 },
    90000,
  );
  const j = extractJson(await llmText(outputs));
  const description = typeof j.description === 'string' ? j.description.trim() : '';
  if (description.length < 12) throw new Error('LLM returned an empty description');
  const sample = typeof j.sample === 'string' ? clipPhrase(j.sample.replace(/["«»“”]/g, '').trim(), 200) : '';
  const langName = typeof j.language === 'string' ? j.language.trim().toLowerCase() : '';
  const language = Object.keys(QWEN_LANGS).find((k) => QWEN_LANGS[k].toLowerCase() === langName) ?? 'en';
  return {
    description: `${description.slice(0, 700)} ${ADULT_ONLY}`,
    name: typeof j.name === 'string' ? j.name.trim().slice(0, 40) : '',
    gender: GENDERS.has(String(j.gender)) ? (j.gender as Gender) : guessGender(request),
    age: AGES.has(String(j.age)) ? (j.age as AgeGroup) : null,
    timbre: words(j.timbre),
    manner: words(j.manner),
    sample: sample || DEFAULT_SAMPLE,
    language: sample ? language : 'en',
    via: 'llm',
  };
}
