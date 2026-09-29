/**
 * Prompt templates for Video Studio. They mirror Hypit's kits:
 *  - phone-ugc-v1  → derived presenter stills (Seedream 5.0 Pro edit, 2K)
 *  - speaker-v1    → speaking takes (Seedance 2.5 image-to-video)
 * The user never sees these; the UI only asks for plain-language fields.
 */

export type Performance = 'natural-explainer' | 'high-energy-ugc' | 'calm-authority' | 'reactive-playful';
export type Gesture = 'restrained' | 'compact' | 'natural' | 'expressive';
export type EditRhythm = 'continuous-take' | 'pause-trim-jump-cuts';

const PHONE_UGC =
  'A photograph captured as a single frame from a video actually shot on an iPhone, with the texture of real iPhone footage. ' +
  'The image looks real, without an oily, overprocessed finish: natural skin, natural light, slight sensor grain, ' +
  'true-to-life colours, no beauty filter, no studio polish.';

export interface LookPromptInput {
  outfit?: string;
  pose?: string;
  setting?: string;
  extra?: string;
  aspect: string;
}

/** Seedream edit prompt: keep the person from the reference photo, change only what the user asked. */
export function buildLookPrompt(p: LookPromptInput): string {
  const parts: string[] = [];
  parts.push(
    'Use the person from the reference image. Keep exactly the same face, identity, skin tone, hair colour and hairstyle, ' +
      'body proportions and age so they are unmistakably the same person.',
  );
  if (p.outfit?.trim()) parts.push(`Outfit: ${p.outfit.trim()}.`);
  if (p.pose?.trim()) parts.push(`Shot and pose: ${p.pose.trim()}.`);
  else parts.push('Shot: a close half-body view, facing the camera, head and shoulders comfortably inside the frame, natural relaxed posture.');
  if (p.setting?.trim()) parts.push(`Setting: ${p.setting.trim()}.`);
  if (p.extra?.trim()) parts.push(p.extra.trim());
  parts.push(`${p.aspect} framing suitable as the first frame of a talking-head video.`);
  parts.push(PHONE_UGC);
  parts.push('No on-screen text, no captions, no logos, no watermark.');
  return parts.join('\n');
}

export interface TakePromptInput {
  dialogue: string;
  action?: string;
  voice?: string;
  performance?: Performance;
  gesture?: Gesture;
  editRhythm?: EditRhythm;
  /** 'image' = start frame is the still; 'reference' = still + optional voice sample are references. */
  mode: 'image' | 'reference';
  hasVoiceSample?: boolean;
  language?: string;
}

const PERFORMANCE: Record<Performance, string> = {
  'natural-explainer': 'natural, conversational explainer energy: clear, friendly, unhurried, with real facial expression',
  'high-energy-ugc': 'high-energy UGC creator delivery: punchy, animated, quick comedic timing, strong emphasis',
  'calm-authority': 'calm authority: composed, measured pace, confident and warm',
  'reactive-playful': 'reactive and playful: expressive reactions, raised eyebrows, smiles, light sarcasm',
};
const GESTURE: Record<Gesture, string> = {
  restrained: 'almost no hand movement, expression carries the delivery',
  compact: 'small compact hand gestures close to the body',
  natural: 'natural hand gestures that follow the speech',
  expressive: 'expressive hand gestures, an emphatic gesture on key words (no exact numbers shown with fingers)',
};
const RHYTHM: Record<EditRhythm, string> = {
  'continuous-take': 'one continuous unbroken take',
  'pause-trim-jump-cuts': 'social-video rhythm: pauses trimmed with subtle jump cuts at phrase boundaries, framing stays locked',
};

export function buildTakePrompt(p: TakePromptInput): string {
  const lines: string[] = [];
  if (p.mode === 'image') {
    lines.push(
      'Vertical phone-shot talking-head video. The video starts exactly from the provided image: same person, same framing, same room, same lighting. ' +
        'The person looks into the camera and speaks directly to the viewer.',
    );
  } else {
    lines.push(
      'Vertical phone-shot talking-head video. The person from the reference image speaks directly to the camera in the same setting and outfit as the reference image.' +
        (p.hasVoiceSample ? ' The reference audio defines the voice timbre and manner of speaking.' : ''),
    );
  }
  if (p.voice?.trim()) lines.push(`Voice: ${p.voice.trim()}.`);
  const lang = p.language && p.language !== 'auto' ? ` (spoken in ${p.language})` : '';
  lines.push(`They say exactly this, word for word, in this order, without adding, rewording or skipping anything${lang}:\n"${p.dialogue.trim()}"`);
  if (p.action?.trim()) lines.push(`Direction: ${p.action.trim()}`);
  lines.push(
    `Performance: ${PERFORMANCE[p.performance || 'natural-explainer']}. Gestures: ${GESTURE[p.gesture || 'natural']}. ` +
      `Editing: ${RHYTHM[p.editRhythm || 'continuous-take']}. Camera: static, locked framing, no zoom, no pan.`,
  );
  lines.push('Photoreal, realistic lip sync, clean synchronized speech audio, no background music, no on-screen text, no captions, no subtitles, no watermark.');
  return lines.join('\n');
}

export interface SwapPromptInput {
  /** Free-text notes about the new person (optional). */
  notes?: string;
  /** Whether the new person's outfit should come from the reference image. */
  keepOutfit?: boolean;
}

/** Seedance video-edit: swap only the person in the shot, keep the footage itself. */
export function buildSwapPrompt(p: SwapPromptInput = {}): string {
  const lines = [
    'The character from the reference image is the actor in this video: same appearance as in the reference (hair, skin tone, age, build), ' +
      'consistent in every frame.',
    'The actor gives precisely the same performance as in the input video: the same head movements, gestures, expressions and lip movements, in sync with the speech.',
    p.keepOutfit
      ? 'They wear the outfit from the original video.'
      : 'They wear the outfit from the reference image if it is visible there, otherwise the outfit from the original video.',
    'Keep everything else exactly as in the input video: framing, camera motion, timing, background, lighting, and every on-screen element ' +
      '(captions, stickers, emojis, flags, logos, text).',
  ];
  if (p.notes?.trim()) lines.push(p.notes.trim());
  lines.push('Photoreal, no new text, no watermark, no other changes.');
  return lines.join('\n');
}

/** B-roll insert: a self-contained joke/illustration image. */
export function buildInsertPrompt(prompt: string): string {
  const base = prompt.trim();
  const hygiene = /\b(no (readable )?text|no logos?)\b/i.test(base) ? '' : ' No readable text, no logos, no watermark.';
  return `${base}${hygiene}`;
}
