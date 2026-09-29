/**
 * Built-in voice library: 20 women aged 18-40, each a distinct personality (timbre, pitch, energy, way of talking).
 * Every voice is a "recipe": a description for Qwen3 Voice Design plus an in-character English phrase. The phrase is
 * synthesized once (POST /api/voice/presets/prepare) and the clip becomes the voice's anchor: all speech in this voice
 * is OmniVoice voice-clone of that clip, so the voice and its manner stay the same on every call, in any language.
 * The phrases are casual, emotional speech (not announcements), because the clone copies the anchor's delivery.
 * Each voice has its own accent, voice quality and pace, so no two voices differ only in pitch. Phrases run up to 150
 * characters (8-10 s of speech, the upper end of what OmniVoice wants): long enough to carry the accent and rhythm.
 */

export type Gender = 'female' | 'male';
/** young 18-24, adult 25-32, mature 33-40. */
export type AgeGroup = 'young' | 'adult' | 'mature';

export interface VoicePreset {
  id: string;
  name: string;
  gender: Gender;
  age: AgeGroup;
  ageYears: number;
  /** How the voice sounds. */
  timbre: string[];
  /** How she talks. */
  manner: string[];
  /** Who she is, in a few words. */
  useCase: string;
  /** Qwen3 Voice Design description. */
  prompt: string;
  /** Anchor phrase, up to 150 characters. */
  sampleText: string;
}

const NATURAL = 'Natural, human delivery with real emotion, subtle breaths and unforced pauses; never robotic or announcer-like.';

/** Appended to every voice description: the product only has adult voices (no children, teens or elderly). */
export const ADULT_ONLY = 'The speaker is clearly an adult between 18 and 40, not a child, a teenager or an elderly person.';

const woman = (p: Omit<VoicePreset, 'gender' | 'age'>): VoicePreset => ({
  ...p,
  gender: 'female',
  age: p.ageYears <= 24 ? 'young' : p.ageYears <= 32 ? 'adult' : 'mature',
  prompt: `${p.prompt} ${NATURAL} ${ADULT_ONLY}`,
});

const RECIPES: VoicePreset[] = [
  woman({
    id: 'grace',
    name: 'Grace',
    ageYears: 34,
    timbre: ['velvety', 'warm'],
    manner: ['calm', 'confiding'],
    useCase: 'podcast host, warm and thoughtful',
    prompt:
      'Woman, 34. Warm, velvety, medium-low voice. Calm, thoughtful and reassuring, like a podcast host in an honest late-evening conversation. Unhurried pace, soft pauses, gentle intonation.',
    sampleText: "You know, I've been thinking about this a lot... and honestly, there's no rush.",
  }),
  woman({
    id: 'chloe',
    name: 'Chloe',
    ageYears: 23,
    timbre: ['vocal fry', 'bright'],
    manner: ['chatty', 'uptalk'],
    useCase: 'LA lifestyle influencer',
    prompt:
      'Woman, 23, from Los Angeles with a Californian accent. Medium-pitched voice with vocal fry at the ends of phrases and rising uptalk. Chatty lifestyle influencer, relaxed and bubbly, says "like" and "literally" a lot, talks to the listener like a best friend.',
    sampleText: "Okay, so, like, I literally found the cutest café yesterday? And the matcha was, like, so good. I'm not even kidding, you guys have to go.",
  }),
  woman({
    id: 'emma',
    name: 'Emma',
    ageYears: 27,
    timbre: ['warm', 'rounded'],
    manner: ['friendly', 'laughing'],
    useCase: 'Minnesota girl next door',
    prompt:
      'Woman, 27, from Minnesota with a friendly Midwestern accent and long rounded vowels. Warm, round, medium voice. Easygoing girl next door who laughs easily, casual storytelling with fillers, friendly and completely unscripted.',
    sampleText: 'Oh, you betcha! So I walk into the store, right, and ope, I just about knock over the whole display. Ha, everybody turned around!',
  }),
  woman({
    id: 'rachel',
    name: 'Rachel',
    ageYears: 36,
    timbre: ['bright', 'polished'],
    manner: ['upbeat', 'energetic'],
    useCase: 'morning TV host',
    prompt:
      'Woman, 36, American morning TV host with a clean broadcast accent. Bright, clear, well-trained medium voice with crisp articulation and good projection. Upbeat and energetic, a big smile in the voice, lively intonation, polished but warm.',
    sampleText: "Good morning, everybody, and welcome back! We've got sunshine, a surprise guest, and the best pancake recipe you'll ever try. Stay with us!",
  }),
  woman({
    id: 'victoria',
    name: 'Victoria',
    ageYears: 30,
    timbre: ['silky', 'smooth'],
    manner: ['elegant', 'measured'],
    useCase: 'Parisian fashion stylist',
    prompt:
      'Woman, 30, Parisian speaking English with a light, charming French accent. Silky, smooth, medium-low voice. Elegant and self-assured, measured pace, soft rolling intonation and a subtle smile, like a stylist in a Paris boutique.',
    sampleText: 'Voilà, you see? The coat is simple, the shoes are simple... and together, they are magnifique. Style is not effort, chérie. It is confidence.',
  }),
  woman({
    id: 'jade',
    name: 'Jade',
    ageYears: 22,
    timbre: ['husky', 'gritty'],
    manner: ['sassy', 'fast'],
    useCase: 'cheeky Londoner',
    prompt:
      'Woman, 22, from East London with a strong London accent, dropped t-sounds and glottal stops. Husky, slightly gritty, medium-low voice. Sassy, cheeky and fast-talking, playful sarcasm, confident street attitude.',
    sampleText: "Nah, listen, yeah? I told him straight: you're not bringing that rubbish round my flat again. Honestly, the cheek of it. Unbelievable, innit?",
  }),
  woman({
    id: 'zoe',
    name: 'Zoe',
    ageYears: 25,
    timbre: ['crisp', 'ringing'],
    manner: ['very fast', 'excited'],
    useCase: 'Canadian tech reviewer',
    prompt:
      'Woman, 25, from Toronto with a light Canadian accent. Medium-low pitched, clear and crisp adult voice that stays in a relaxed low register even when she gets excited, never squeaky. Talks very fast, like a tech reviewer who cannot wait to show the next feature: rapid rhythm, quick breaths, animated.',
    sampleText: "Okay, okay, look at this, eh? Ten minutes on the charger, full battery, and it's not even warm. Sorry, but that is honestly just unreal!",
  }),
  woman({
    id: 'lily',
    name: 'Lily',
    ageYears: 33,
    timbre: ['airy', 'gentle'],
    manner: ['very slow', 'soothing'],
    useCase: 'Irish yoga teacher',
    prompt:
      'Woman, 33, from the west of Ireland with a soft, lilting Irish accent. Airy, gentle, medium-pitched voice with a little breath in it. Very slow and calm, long peaceful pauses, soothing melodic intonation, like a yoga teacher at sunset.',
    sampleText: "Now... let the breath come in, nice and slow. Sure, there's no rush at all. Let the shoulders go soft... and just rest there a while.",
  }),
  woman({
    id: 'sam',
    name: 'Sam',
    ageYears: 29,
    timbre: ['dry', 'nasal'],
    manner: ['deadpan', 'sarcastic'],
    useCase: 'New York stand-up comic',
    prompt:
      'Woman, 29, from Brooklyn with a noticeable New York accent. Dry, slightly nasal, medium-low voice. Deadpan and nearly monotone: flat, unimpressed delivery, sarcastic understatement, a small pause before each punchline, never laughs at her own jokes.',
    sampleText: 'So I tried meditation. Twenty minutes, total silence, I finally found my inner self... and she was also annoyed. Great. Very relaxing.',
  }),
  woman({
    id: 'bella',
    name: 'Bella',
    ageYears: 24,
    timbre: ['bright', 'nasal'],
    manner: ['very fast', 'emotional'],
    useCase: 'beauty blogger',
    prompt:
      'Woman, 24, American beauty blogger. Bright, slightly nasal adult voice in a comfortable mid-to-low register that stays there even at her most excited, never squeaky or childlike. Very fast and very emotional: little gasps, excited emphasis and exclamations, words tumbling out, genuinely thrilled.',
    sampleText: "Oh my gosh, stop! Look at this shade, it's literally glowing! I've been waiting for this all year, and it's even better than I imagined!",
  }),
  woman({
    id: 'catherine',
    name: 'Catherine',
    ageYears: 38,
    timbre: ['low', 'crisp'],
    manner: ['fast', 'decisive'],
    useCase: 'executive running the meeting',
    prompt:
      'Woman, 38, American executive with a polished, neutral accent. Low-pitched, crisp, firm alto voice with precise consonants that stays low and steady even when she speaks fast. Fast, confident and decisive: short sentences, no hesitation, calm authority, like she is chairing the board meeting.',
    sampleText: "Okay, here's where we are. Revenue is up, costs are flat, and the deadline does not move. I need answers by Friday. Questions? Good. Let's go.",
  }),
  woman({
    id: 'ava',
    name: 'Ava',
    ageYears: 28,
    timbre: ['breathy', 'soft'],
    manner: ['half-whisper', 'soothing'],
    useCase: 'relaxation and ASMR',
    prompt:
      'Woman, 28. Soft, breathy, airy voice, speaking quietly and close to the microphone in a gentle half-whisper. Soothing, tender and intimate, slow and calm.',
    sampleText: "Close your eyes... take a slow, deep breath... that's it. Just let yourself rest.",
  }),
  woman({
    id: 'sarah',
    name: 'Sarah',
    ageYears: 35,
    timbre: ['warm', 'clear'],
    manner: ['patient', 'kind'],
    useCase: 'kind teacher from Bangalore',
    prompt:
      'Woman, 35, from Bangalore speaking English with a light Indian accent. Warm, clear, medium voice with gentle, careful articulation. Patient and kind teacher, calm encouraging pace, smiles while explaining, reassuring.',
    sampleText: "No problem at all, take your time. We'll do it step by step, okay? First the formula, then one small example. See? You're getting it already.",
  }),
  woman({
    id: 'mia',
    name: 'Mia',
    ageYears: 21,
    timbre: ['bright', 'clear'],
    manner: ['playful', 'laughing'],
    useCase: 'Aussie friend who teases you',
    prompt:
      'Woman, 21, from Sydney with a broad Australian accent. Clear, bright, medium-pitched adult voice. Playful and teasing, laughs in the middle of sentences, relaxed and cheeky, big rises and falls in intonation.',
    sampleText: "Haha, no way, mate! You drove all the way to the beach and forgot your swimmers? Reckon that's the funniest thing I've heard all week.",
  }),
  woman({
    id: 'scarlett',
    name: 'Scarlett',
    ageYears: 31,
    timbre: ['deep', 'contralto'],
    manner: ['theatrical', 'slow'],
    useCase: 'British stage actress',
    prompt:
      'Woman, 31, English stage actress with a refined British accent. Low-pitched, dark, rich contralto voice resonating from the chest. Theatrical and slow: long dramatic pauses, savours every word, stays low and never shrill even at emotional peaks.',
    sampleText: 'Darling, the theatre was half empty, and still... I played every line as if the whole of London were listening. That is the job, my dear.',
  }),
  woman({
    id: 'luna',
    name: 'Luna',
    ageYears: 20,
    timbre: ['hazy', 'husky'],
    manner: ['dreamy', 'slow'],
    useCase: 'stargazing dreamer',
    prompt:
      'Woman, 20, with a soft American accent. Hazy, slightly husky, medium-low voice with some air in it, speaking softly but not whispering. Dreamy and wistful, slow, drifting melodic intonation, as if thinking aloud under the night sky.',
    sampleText: "Do you ever look up at the stars and feel... like they're looking back? I think every single one of them has a story, just waiting for us.",
  }),
  woman({
    id: 'roxy',
    name: 'Roxy',
    ageYears: 39,
    timbre: ['smoky', 'raspy'],
    manner: ['drawling', 'ironic'],
    useCase: 'Texas bartender who has heard it all',
    prompt:
      'Woman, 39, from Texas with a slow Southern drawl. Low, smoky, slightly raspy voice with vocal fry at the ends of phrases. Laid-back and lazily ironic, stretched vowels, unhurried and amused, like a bartender who has heard every story twice.',
    sampleText: "Well, honey, y'all can argue about it all night long. I'll just pour another one, sit right here, and wait for somebody to admit I was right.",
  }),
  woman({
    id: 'ellie',
    name: 'Ellie',
    ageYears: 19,
    timbre: ['quiet', 'soft'],
    manner: ['shy', 'hesitant'],
    useCase: 'shy exchange student from Madrid',
    prompt:
      'Woman, 19, from Madrid speaking English with a light Spanish accent. Quiet, soft, medium-pitched adult voice. Shy and hesitant: small pauses, "um" and self-corrections, a nervous little laugh, warm and sincere.',
    sampleText: 'Um, hi... sorry, my English is, um, not perfect. I just wanted to say thank you, really. Bueno, it meant a lot to me, you know?',
  }),
  woman({
    id: 'riley',
    name: 'Riley',
    ageYears: 26,
    timbre: ['raspy', 'powerful'],
    manner: ['assertive', 'punchy'],
    useCase: 'rock singer',
    prompt:
      'Woman, 26, American rock singer. Raspy, powerful, medium-low voice with grit and real volume. Assertive and punchy, hits key words hard, fast and direct, raw fearless energy.',
    sampleText: "Listen to me. Nobody's coming to hand you the stage. You plug in, you turn it up, and you play like it's the last night on earth. Got it?",
  }),
  woman({
    id: 'maddie',
    name: 'Maddie',
    ageYears: 18,
    timbre: ['lively', 'clear'],
    manner: ['curious', 'uptalk'],
    useCase: 'Glasgow student',
    prompt:
      'Woman, 18, a first-year university student from Glasgow with a strong Scottish accent. Lively, clear, medium-pitched adult voice. Curious and animated, quick pace, rising intonation at the ends of sentences, sincere and a bit amazed.',
    sampleText: "Wait, so you're telling me the library's open all night? Aye, that's brilliant, like. I'd have been in there every single day if I'd known!",
  }),
];

/** Library order: the most versatile voices first, calm and lively ones alternating. */
const ORDER = [
  'grace', 'chloe', 'emma', 'rachel', 'victoria', 'jade', 'zoe', 'lily', 'sam', 'bella',
  'catherine', 'ava', 'sarah', 'mia', 'scarlett', 'luna', 'roxy', 'ellie', 'riley', 'maddie',
];

export const PRESETS: VoicePreset[] = [...RECIPES].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

export function findPreset(id: string): VoicePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
