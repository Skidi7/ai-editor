/** Voice Studio model. Voices live on the server (library); history and drafts live in localStorage. */

export type Gender = 'female' | 'male';
/** young 18-24, adult 25-32, mature 33-40: the product only has adult voices up to 40. */
export type AgeGroup = 'young' | 'adult' | 'mature';
export type VoiceSource = 'preset' | 'design' | 'capture' | 'clone' | 'mic';
export type Tab = 'speak' | 'design' | 'capture' | 'clone';

/**
 * A library voice. Its identity is the anchor clip (`sample`) plus the exact words spoken in it (`sampleText`):
 * every generation is OmniVoice voice-clone of that clip, so the voice sounds the same each time.
 */
export interface Voice {
  id: string;
  kind: 'preset' | 'custom';
  name: string;
  gender: Gender | null;
  age: AgeGroup | null;
  ageYears?: number;
  timbre: string[];
  manner: string[];
  useCase?: string;
  description: string;
  /** Playable anchor clip; null while a built-in voice has not been prepared. */
  sample: string | null;
  sampleText: string;
  /** Built-in voices: length of the phrase a (re)generation records now (the recipe may be newer than the clip). */
  recipeChars?: number;
  source: VoiceSource;
  createdAt: number;
}

export interface VoicePrices {
  omniFlat: number;
  omniPerChar: number;
  qwenPer100: number;
  isolatePerSecond: number;
  whisperPerSecond: number;
  whisperTimedPerSecond: number;
  llmPerRun: number;
}

export interface VoiceServerInfo {
  provider: 'wavespeed' | 'mock';
  ffmpeg: boolean;
  models: Record<string, string>;
  prices: VoicePrices;
  presets: { total: number; ready: number };
  /** false where visitors must not (re)make the built-in voices (VOICE_PRESETS_EDITABLE=false). */
  presetsEditable?: boolean;
  /** Server-wide daily spend guard (VOICE_DAILY_BUDGET_USD). */
  /** daily: null = no limit */
  budget?: { daily: number | null; spentToday: number };
}

export interface HistoryItem {
  id: string;
  createdAt: number;
  kind: 'speak' | 'clone' | 'test';
  text: string;
  voiceId: string | null;
  voiceName: string;
  gender: Gender | null;
  age: AgeGroup | null;
  url: string;
  duration: number | null;
  cost: number;
  speed: number;
  lang: string | null;
  mock?: boolean;
}

/** The voice the AI cast from a «Create voice» description (server/src/voice/design.ts). */
export interface VoiceSpec {
  /** English description sent to Qwen3 Voice Design. */
  description: string;
  name: string;
  gender: Gender | null;
  age: AgeGroup | null;
  timbre: string[];
  manner: string[];
  sample: string;
  language: string;
  via: 'llm' | 'rules';
}

/** One «Create voice» request: the cast voice and one take of it. More takes of the same voice reuse `id`. */
export interface DesignResult {
  id: string;
  spec: VoiceSpec;
  sampleText: string;
  /** Language of the sample phrase, e.g. "English". */
  language: string;
  take: { id: string; url: string };
  cost: number;
  mock?: boolean;
}

/** Reference clip cut from a file / recording and stored on the server. */
export interface PreparedSample {
  url: string;
  seconds: number;
  cleaned: boolean;
}

export const DEFAULT_PRICES: VoicePrices = {
  omniFlat: 0.005,
  omniPerChar: 0.00005,
  qwenPer100: 0.005,
  isolatePerSecond: 0.001,
  whisperPerSecond: 0.001,
  whisperTimedPerSecond: 0.002,
  llmPerRun: 0.001,
};

export const AGE_GROUPS: { id: AgeGroup; label: string }[] = [
  { id: 'young', label: '18–24' },
  { id: 'adult', label: '25–32' },
  { id: 'mature', label: '33–40' },
];

export function ageLabel(v: Pick<Voice, 'age' | 'ageYears'>): string {
  if (v.ageYears) return `${v.ageYears} y/o`;
  const g = AGE_GROUPS.find((a) => a.id === v.age);
  return g ? `${g.label} y/o` : '';
}

export function usd(v: number): string {
  if (!v) return '$0';
  if (v < 0.1) return `$${v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${v.toFixed(2)}`;
}
