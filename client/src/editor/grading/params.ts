export type RGB = [number, number, number];

export interface GradeParams {
  // Match reference
  match: boolean;
  matchStrength: number; // 0..100

  // Colour correct
  colorCorrect: boolean;
  temperature: number; // -100..100
  tint: number; // -100..100
  saturation: number; // -100..100
  vibrance: number; // -100..100
  contrast: number; // -100..100

  // Soften details
  soften: boolean;
  softenAmount: number; // 0..100

  // Lens
  lens: boolean;
  vignette: number; // 0..100
  chromatic: number; // 0..100
  sharpen: number; // 0..100

  // Exposure
  exposure: boolean;
  exposureEv: number; // -3..3
  highlights: number; // -100..100
  shadows: number; // -100..100

  // Film grain
  grain: boolean;
  grainAmount: number; // 0..100
  grainSize: number; // 1..4

  // Look (driven by presets)
  bw: boolean;
  fade: number; // 0..100 lifted blacks
  splitAmount: number; // 0..100
  splitShadow: RGB; // 0..255
  splitHighlight: RGB;
}

export const DEFAULT_PARAMS: GradeParams = {
  match: false,
  matchStrength: 80,
  colorCorrect: false,
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  contrast: 0,
  soften: false,
  softenAmount: 30,
  lens: false,
  vignette: 30,
  chromatic: 20,
  sharpen: 0,
  exposure: false,
  exposureEv: 0,
  highlights: 0,
  shadows: 0,
  grain: false,
  grainAmount: 30,
  grainSize: 1.5,
  bw: false,
  fade: 0,
  splitAmount: 0,
  splitShadow: [20, 110, 170],
  splitHighlight: [255, 190, 120],
};

export interface Preset {
  id: string;
  name: string;
  params: Partial<GradeParams>;
}

const cc = (p: Partial<GradeParams>): Partial<GradeParams> => ({ colorCorrect: true, ...p });

export const PRESETS: Preset[] = [
  { id: 'none', name: 'None', params: {} },

  // Clean / everyday
  { id: 'natural', name: 'Natural', params: cc({ vibrance: 18, contrast: 8, saturation: 4, exposure: true, shadows: 12, highlights: -8 }) },
  { id: 'vivid', name: 'Vivid', params: cc({ vibrance: 40, saturation: 15, contrast: 14, exposure: true, highlights: -10 }) },
  { id: 'clean', name: 'Clean Bright', params: cc({ exposure: true, exposureEv: 0.25, shadows: 20, highlights: -15, vibrance: 10, contrast: -4, temperature: 3 }) },
  { id: 'warm', name: 'Warm', params: cc({ temperature: 30, tint: 4, vibrance: 12, contrast: 6, exposure: true, shadows: 8 }) },
  { id: 'cool', name: 'Cool', params: cc({ temperature: -28, tint: -4, vibrance: 8, contrast: 8 }) },
  { id: 'golden', name: 'Golden Hour', params: cc({ temperature: 35, tint: 6, vibrance: 15, contrast: 8, splitAmount: 30, splitShadow: [90, 60, 40], splitHighlight: [255, 200, 120], exposure: true, shadows: 10, fade: 4 }) },

  // Cinematic
  { id: 'cinematic', name: 'Cinematic', params: cc({ contrast: 18, saturation: -10, splitAmount: 38, splitShadow: [0, 90, 150], splitHighlight: [255, 170, 90], lens: true, vignette: 32, chromatic: 0, fade: 6 }) },
  { id: 'tealorange', name: 'Teal & Orange', params: cc({ contrast: 14, saturation: 4, vibrance: 10, splitAmount: 60, splitShadow: [0, 120, 150], splitHighlight: [255, 160, 80], lens: true, vignette: 18, chromatic: 0 }) },
  { id: 'moody', name: 'Moody', params: cc({ exposure: true, exposureEv: -0.35, highlights: -25, shadows: -10, contrast: 20, saturation: -18, temperature: -8, splitAmount: 30, splitShadow: [20, 40, 70], splitHighlight: [200, 180, 160], lens: true, vignette: 40, chromatic: 0, fade: 8 }) },
  { id: 'noir', name: 'Noir', params: cc({ bw: true, contrast: 35, exposure: true, highlights: -15, shadows: -20, lens: true, vignette: 55, chromatic: 0, grain: true, grainAmount: 22, grainSize: 1.4 }) },
  { id: 'bleach', name: 'Bleach Bypass', params: cc({ saturation: -50, contrast: 32, exposure: true, highlights: 10, shadows: -10, grain: true, grainAmount: 18, grainSize: 1.3 }) },
  { id: 'neon', name: 'Neon Night', params: cc({ vibrance: 40, saturation: 10, contrast: 12, temperature: -12, splitAmount: 55, splitShadow: [120, 20, 160], splitHighlight: [40, 220, 255], exposure: true, shadows: 8, lens: true, vignette: 25, chromatic: 10 }) },

  // Film
  { id: 'portra', name: 'Portra', params: cc({ temperature: 12, tint: 3, saturation: -6, vibrance: 8, contrast: 4, fade: 10, splitAmount: 22, splitShadow: [60, 80, 90], splitHighlight: [255, 215, 170], grain: true, grainAmount: 16, grainSize: 1.3 }) },
  { id: 'fuji', name: 'Fuji Green', params: cc({ temperature: -4, tint: -10, saturation: -4, vibrance: 12, contrast: 8, fade: 8, splitAmount: 25, splitShadow: [20, 90, 80], splitHighlight: [230, 235, 200], grain: true, grainAmount: 14, grainSize: 1.3 }) },
  { id: 'film16', name: '16mm Film', params: cc({ grain: true, grainAmount: 48, grainSize: 2.2, saturation: -8, contrast: 10, temperature: 8, fade: 12, lens: true, vignette: 22, chromatic: 6, soften: true, softenAmount: 14, splitAmount: 18, splitShadow: [70, 60, 50], splitHighlight: [255, 220, 170] }) },
  { id: 'vintage', name: 'Vintage', params: cc({ temperature: 15, tint: 5, saturation: -20, contrast: -6, fade: 25, splitAmount: 35, splitShadow: [90, 70, 50], splitHighlight: [255, 225, 160], lens: true, vignette: 35, chromatic: 8, grain: true, grainAmount: 24, grainSize: 1.8 }) },
  { id: 'faded', name: 'Faded Film', params: cc({ fade: 32, contrast: -8, saturation: -12, temperature: 6, exposure: true, exposureEv: 0.1, grain: true, grainAmount: 18, grainSize: 1.5 }) },
  { id: 'crossprocess', name: 'Cross Process', params: cc({ contrast: 22, saturation: 12, splitAmount: 55, splitShadow: [30, 110, 60], splitHighlight: [255, 230, 90], tint: -6, fade: 6 }) },
  { id: 'oldlens', name: 'Old Lens', params: cc({ lens: true, chromatic: 45, vignette: 48, soften: true, softenAmount: 26, fade: 15, temperature: 12, saturation: -6 }) },

  // Black & white / toned
  { id: 'bw', name: 'B&W Film', params: cc({ bw: true, contrast: 18, grain: true, grainAmount: 28, grainSize: 1.6, fade: 8 }) },
  { id: 'bwsoft', name: 'B&W Soft', params: cc({ bw: true, contrast: -6, fade: 18, exposure: true, exposureEv: 0.15, shadows: 15, soften: true, softenAmount: 12 }) },
  { id: 'sepia', name: 'Sepia', params: cc({ bw: true, contrast: 8, fade: 10, splitAmount: 70, splitShadow: [95, 70, 45], splitHighlight: [255, 225, 175] }) },
  { id: 'split', name: 'Split Tone', params: cc({ splitAmount: 45, splitShadow: [10, 100, 170], splitHighlight: [255, 185, 110], contrast: 6, fade: 4 }) },

  // Portrait / soft
  { id: 'softskin', name: 'Soft Skin', params: cc({ soften: true, softenAmount: 32, exposure: true, exposureEv: 0.12, saturation: -4, temperature: 6 }) },
  { id: 'softnature', name: 'Soft Nature', params: cc({ soften: true, softenAmount: 18, vibrance: 22, temperature: 8, fade: 8, exposure: true, shadows: 10 }) },
  { id: 'pastel', name: 'Pastel', params: cc({ fade: 26, saturation: -14, vibrance: 6, contrast: -14, exposure: true, exposureEv: 0.2, shadows: 15, temperature: 5, tint: 4 }) },
];

export function applyPreset(base: GradeParams, preset: Preset): GradeParams {
  // Presets start from defaults so switching between them is predictable; the reference match is kept.
  return { ...DEFAULT_PARAMS, match: base.match, matchStrength: base.matchStrength, ...preset.params };
}

/** True when nothing in the params would change the image. */
export function isIdentity(p: GradeParams): boolean {
  return (
    !p.match && !p.colorCorrect && !p.soften && !p.lens && !p.exposure && !p.grain && !p.bw && p.fade === 0 && p.splitAmount === 0
  );
}
