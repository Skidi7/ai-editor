/** Hidden prompt used by "Expand & Crop → Fill with AI". The user never sees it. */
/**
 * The model receives the ORIGINAL photo and the target aspect ratio; Seedream outpaints natively
 * (the same flow as running this prompt in the WaveSpeed playground with a different aspect ratio).
 */
export const EXPAND_PROMPT =
  'Extend the image based on the original. Extend the image while maintaining the aspect ratio. ' +
  'The image extension is based on the original image and its style.';

export interface RelightParams {
  /** Degrees: 0 = light from the front (camera side), +90 = from the viewer's right, ±180 = from behind the subject. */
  azimuth: number;
  /** Degrees: +90 = straight above, 0 = eye level, -90 = from below. */
  elevation: number;
  /** 0..100 */
  brightness: number;
  /** #rrggbb */
  color: string;
}

function describeDirection(azimuth: number, elevation: number): string {
  const az = ((azimuth % 360) + 540) % 360 - 180; // -180..180
  const side = az > 0 ? 'right' : 'left';
  const a = Math.abs(az);
  let horizontal: string;
  if (a < 15) horizontal = 'from straight ahead (the camera side)';
  else if (a < 45) horizontal = `from the front, slightly to the ${side}`;
  else if (a < 75) horizontal = `from the front-${side} (45 degrees)`;
  else if (a < 110) horizontal = `from the ${side} side, outside the frame on the ${side}`;
  else if (a < 160) horizontal = `from behind the subject on the ${side} (rim/back light)`;
  else horizontal = 'from directly behind the subject (backlight)';
  let vertical: string;
  if (elevation > 60) vertical = 'high above, almost overhead';
  else if (elevation > 25) vertical = 'from above the subject\'s head';
  else if (elevation > 8) vertical = 'slightly above eye level';
  else if (elevation > -8) vertical = 'at the subject\'s eye level';
  else if (elevation > -25) vertical = 'slightly below eye level (around chest/hip height)';
  else if (elevation > -60) vertical = 'from below (around knee height, lighting upward)';
  else vertical = 'from far below, near the ground, lighting upward';
  return `${horizontal}, ${vertical}`;
}

function describeColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 'neutral white';
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v, 16));
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 24) return max > 200 ? 'neutral white' : 'dim neutral';
  if (r >= g && g >= b) return r - b > 120 ? 'warm orange/amber' : 'warm golden';
  if (r >= b && b >= g) return 'pink/magenta';
  if (g >= r && r >= b) return 'yellow-green';
  if (g >= b && b >= r) return 'green/teal';
  if (b >= g && g >= r) return 'cool blue';
  return 'violet/purple';
}

export function buildRelightPrompt(p: RelightParams, withGuide = false): string {
  const strength = p.brightness < 25 ? 'subtle, low-intensity' : p.brightness < 55 ? 'moderate' : p.brightness < 80 ? 'strong' : 'very strong, dominant';
  const guide = withGuide
    ? 'Image 1 is the original photo. Image 2 is the same photo with a guide overlay: the lamp icon marks where the light source is ' +
      'and the arrow shows the direction the light travels toward the subject; the darkened part of image 2 is the shadow side. ' +
      'Relight image 1 accordingly and photorealistically. Image 2 is only a diagram: do NOT draw the icon, the arrow, the darkening, ' +
      'any glow, haze or light spot in the scene. '
    : 'Relight this photo. ';
  return (
    guide +
    `A ${strength} natural, realistic light source, colour ${describeColor(p.color)} (${p.color}), ` +
    `is aimed at the main subject and comes ${describeDirection(p.azimuth, p.elevation)}. ` +
    `Match the strength: ${strength} — at ${p.brightness}% intensity; never brighter than the preview suggests. ` +
    'The light must illuminate the main subject itself (the person: face, hair, skin, body and clothes) from that side, ' +
    'like a large lamp pointed at them, with the opposite side of the subject falling into softer shadow, and the ' +
    'surroundings lit consistently with the same direction. ' +
    'Do NOT paint a separate light beam, streak, spotlight patch, ray, lens flare or a visible lamp; no stray light on the floor only. ' +
    'Keep the lighting physically plausible: smooth gradual shading, natural highlights, cast and contact shadows, specular ' +
    'reflections and subtle colour bounce, all consistent with the light direction. ' +
    'Everything else must stay exactly the same: same subject, face, pose, expression, clothing, objects, background, composition, ' +
    'framing and camera angle; do not add, remove or move anything; do not change the colours of objects except for the effect of the light. ' +
    'Output the full photo at the same framing.'
  );
}

export function buildReplaceBackgroundPrompt(userPrompt: string): string {
  return (
    `Replace the background of this photo with: ${userPrompt.trim()}. ` +
    'Keep the subject exactly as they are: same identity, face, pose, clothing, size, position and framing. ' +
    'Integrate the subject into the new scene realistically: natural lighting, shadows, reflections and perspective, ' +
    'so it looks like one real photograph taken in that place.'
  );
}

/**
 * Builds the instruction for a region-targeted edit. Seedream 5.0 Pro has no explicit mask input, so the
 * region is conveyed two ways at once: a second "marked" copy of the image with the selection outlined,
 * and the bounding box on a 0..1000 grid inside the prompt.
 */
export function buildMaskedEditPrompt(userPrompt: string, bbox?: [number, number, number, number]): string {
  const box = bbox ? ` <bbox>${bbox.map((v) => Math.round(v)).join(' ')}</bbox>` : '';
  return (
    'Image 1 is the original photo. Image 2 is the same photo with the target region outlined in red' +
    `${box}. ` +
    `Edit ONLY the outlined region as follows: ${userPrompt.trim()}. ` +
    'Keep everything outside the region exactly identical: same composition, framing, lighting, colours and details. ' +
    'Output the complete photo at the same framing, without any red outline or markings.'
  );
}

export function buildGlobalEditPrompt(userPrompt: string): string {
  return `${userPrompt.trim()}. Keep the original composition, framing and subject; apply only the requested change.`;
}
