/** Video Studio project model. Everything the user edits lives here; it is persisted to localStorage. */

export type Aspect = '9:16' | '1:1' | '16:9';
export type Resolution = '480p' | '720p' | '1080p';
export type Performance = 'natural-explainer' | 'high-energy-ugc' | 'calm-authority' | 'reactive-playful';
export type Gesture = 'restrained' | 'compact' | 'natural' | 'expressive';
export type EditRhythm = 'continuous-take' | 'pause-trim-jump-cuts';
export type TakeMode = 'image' | 'reference';

export type AssetStatus = 'idle' | 'generating' | 'ready' | 'error';

/** The uploaded video that gets cloned: it is cut into scenes by speech. */
export interface SourceVideo {
  url: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  /**
   * How the scenes were cut: 'local' = pauses in speech + shot changes found in the browser,
   * 'whisper' = Whisper phrases, 'chunks' = equal pieces (nothing else worked). null until analysed.
   */
  analyzed: 'local' | 'whisper' | 'chunks' | null;
  /** true once Whisper filled the scenes with text. */
  transcribed?: boolean;
}

/** A presenter still: the uploaded photo itself, or a Seedream-derived variant (other outfit / pose / setting). */
export interface Look {
  id: string;
  name: string;
  image: string | null;
  source: 'photo' | 'generated';
  outfit: string;
  pose: string;
  setting: string;
  status: AssetStatus;
  error?: string;
}

/** A person who can speak in the video. Scenes are assigned to characters; replaced scenes are generated from the character's look. */
export interface Character {
  id: string;
  name: string;
  /** Uploaded reference photo (/media URL). */
  reference: string | null;
  looks: Look[];
  activeLookId: string | null;
  voice: string;
  voiceSample: string | null;
  voiceSampleName: string;
  performance: Performance;
  gesture: Gesture;
  editRhythm: EditRhythm;
  mode: TakeMode;
}

export interface WordTiming {
  start: number;
  end: number;
}

export type InsertFrame = 'left' | 'right' | 'wide' | 'top' | 'center';
export type InsertMotion = 'pop' | 'bounce' | 'scale' | 'fade';
export type InsertAspect = '1:1' | '4:3' | '3:4' | '16:9' | '21:9';

/** A B-roll insert anchored to a range of words in a scene's dialogue. */
export interface Insert {
  id: string;
  sceneId: string;
  startWord: number;
  endWord: number;
  name: string;
  image: string | null;
  prompt: string;
  aspect: InsertAspect;
  frame: InsertFrame;
  /** Custom centre (fractions of the canvas) set by dragging on the preview; overrides `frame`. */
  x?: number;
  y?: number;
  /** % of the canvas width. */
  width: number;
  motion: InsertMotion;
  status: AssetStatus;
  error?: string;
  /** Extra seconds the insert stays after its last word. */
  hold: number;
}

/** Display word stays as written; `speech` is what the presenter is asked to pronounce (e.g. "D" → "Dee"). */
export interface Pronunciation {
  word: number;
  speech: string;
}

export interface Take {
  /** /media URL of the generated (or uploaded) clip. null in mock mode: the still is shown instead. */
  video: string | null;
  remoteUrl?: string;
  duration: number;
  /** Per dialogue word, seconds from the clip start. null → estimated on the fly. */
  words: WordTiming[] | null;
  /** whisper = per-word timestamps; whisper-segments = phrase timestamps, words spread inside each phrase. */
  aligned: 'whisper' | 'whisper-segments' | 'estimate';
  /** edit = the source piece with the person swapped in place (video-edit); seedance = new footage from a still. */
  source: 'seedance' | 'edit' | 'upload' | 'mock';
  /** Source range the edit was made from (edit takes only). */
  range?: { start: number; end: number };
  /** Snapshot of the dialogue the take was generated from, to flag stale takes. */
  dialogue: string;
  lookImage: string | null;
  cost: number;
}

/** keep = play this piece of the source video as is; replace = put the character in (see ReplaceKind). */
export type SceneMode = 'keep' | 'replace';
/** edit = swap the person inside the original footage (video-edit); generate = new footage from the character's still. */
export type ReplaceKind = 'edit' | 'generate';

export interface Scene {
  id: string;
  name: string;
  mode: SceneMode;
  replaceKind?: ReplaceKind;
  speakerId: string | null;
  /** Range in the source video (seconds); null for scenes written from scratch. */
  source: { start: number; end: number } | null;
  /** What was said in the source (Whisper). */
  original: string;
  /** Frame from the source video at the scene start (small JPEG data URL). */
  thumb: string | null;
  /** Word timings of `original` inside the source range, when the transcript had them. */
  sourceWords: WordTiming[] | null;
  dialogue: string;
  action: string;
  lookId: string | null;
  duration: number;
  autoDuration: boolean;
  pronunciations: Pronunciation[];
  captionBreaks: number[];
  take: Take | null;
  status: AssetStatus;
  error?: string;
  progress?: string;
  jobId?: string;
}

export type Tier = 'S' | 'A' | 'B' | 'C' | 'D';

export interface BoardItem {
  id: string;
  name: string;
  icon: string | null;
  tier: Tier;
  /** null → on the board from the start; otherwise drops in when that scene starts. */
  sceneId: string | null;
}

export interface CaptionStyle {
  enabled: boolean;
  font: string;
  size: number;
  color: string;
  highlight: string;
  /** Vertical centre, 0..1 of the canvas height. */
  y: number;
  wordsPerLine: number;
  lines: number;
  uppercase: boolean;
  karaoke: boolean;
}

export interface Style {
  captions: CaptionStyle;
  music: { url: string | null; name: string; gain: number };
  background: string;
  board: { enabled: boolean; items: BoardItem[]; top: number; title: string };
}

export interface Project {
  id: string;
  name: string;
  aspect: Aspect;
  resolution: Resolution;
  language: string;
  source: SourceVideo | null;
  characters: Character[];
  scenes: Scene[];
  inserts: Insert[];
  style: Style;
}

export interface VideoServerInfo {
  provider: 'wavespeed' | 'mock';
  /** false when the server cannot reach api.wavespeed.ai (network / VPN), so generations will fail. */
  reachable?: boolean;
  ffmpeg: boolean;
  whisper: boolean;
  models: { still: string; image: string; take: string; takeReference: string; edit?: string; whisper: string };
  prices: { takePerSecond: Record<Resolution, number>; editPerSecond?: Record<Resolution, number>; image2k: number; whisperPerSecond: number };
}

export type Selection =
  | { type: 'none' }
  | { type: 'scene'; id: string }
  | { type: 'insert'; id: string }
  | { type: 'look'; characterId: string; id: string }
  | { type: 'character'; id: string };

export const ASPECT_SIZE: Record<Aspect, { w: number; h: number }> = {
  '9:16': { w: 720, h: 1280 },
  '1:1': { w: 1080, h: 1080 },
  '16:9': { w: 1280, h: 720 },
};

export const EXPORT_SIZE: Record<Resolution, Record<Aspect, { w: number; h: number }>> = {
  '480p': { '9:16': { w: 480, h: 854 }, '1:1': { w: 720, h: 720 }, '16:9': { w: 854, h: 480 } },
  '720p': { '9:16': { w: 720, h: 1280 }, '1:1': { w: 1080, h: 1080 }, '16:9': { w: 1280, h: 720 } },
  '1080p': { '9:16': { w: 1080, h: 1920 }, '1:1': { w: 1440, h: 1440 }, '16:9': { w: 1920, h: 1080 } },
};

export const TAKE_PRICE_PER_SEC: Record<Resolution, number> = { '480p': 0.18, '720p': 0.36, '1080p': 0.9 };
/** Seedance 2.5 video-edit: per second of input + output (a 5 s clip bills ~10 s). Clips shorter than 4 s are padded to 4 s. */
export const EDIT_PRICE_PER_SEC: Record<Resolution, number> = { '480p': 0.11, '720p': 0.22, '1080p': 0.55 };
export const EDIT_MIN_SECONDS = 4;
export const IMAGE_PRICE = 0.09;
export const WHISPER_PRICE_PER_SEC = 0.002;
