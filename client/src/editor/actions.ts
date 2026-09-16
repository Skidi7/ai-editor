import { apiEdit, apiExpand, apiRelight, apiRemoveBackground, apiReplaceBackground, type RelightSettings } from './api';
import {
  canvasToDataUrl,
  compositeThroughMask,
  coverResize,
  createCanvas,
  cropDoc,
  ctx2d,
  dilateMask,
  downscaleToFit,
  expandRectToRatio,
  extractRegion,
  featherMask,
  flattenDoc,
  loadImage,
  loadImageFromBlob,
  matchTone,
  nearestRatio,
  refineAlpha,
  resizeCanvas,
  roundRect,
  shiftRectIntoBounds,
  uid,
} from './imageUtils';
import { useEditor } from './store';
import { renderLightPreview } from './relightPreview';
import { buildMarkedImage, maskBounds } from './tools/mask';
import type { Layer, Rect } from './types';
import { applyGrade, type MatchInput } from './grading/process';
import type { GradeParams } from './grading/params';

/** Longest side sent to the model. Seedream 5.0 Pro renders at 1K–2K; anything larger is downscaled for the
 *  request and the result is scaled back to the region's native size. Pixels outside the edited region never
 *  pass through the model, so 4K documents stay intact. */
const SEND_MAX_SIDE = 2048;
/** Smallest region (px) sent for a masked edit, so tiny selections still give the model enough context. */
const MIN_REGION = 768;

async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const { setBusy, setError } = useEditor.getState();
  setBusy(label);
  setError(null);
  try {
    return await fn();
  } catch (e) {
    setError((e as Error).message || String(e));
    return undefined;
  } finally {
    setBusy(null);
  }
}

/**
 * Sends the whole image through `call`, padded to a provider-supported aspect ratio so the model never
 * stretches it, and returns a document-sized canvas with the result cropped back to the original framing.
 */
async function generateWholeImage(
  flat: HTMLCanvasElement,
  call: (image: string, width: number, height: number, guide?: string) => Promise<string>,
  guideCanvas?: HTMLCanvasElement,
): Promise<HTMLCanvasElement> {
  const full: Rect = { x: 0, y: 0, w: flat.width, h: flat.height };
  const rect = roundRect(expandRectToRatio(full, nearestRatio(flat.width, flat.height)));
  const region = extractRegion(flat, rect, 'edge');
  const { canvas: small } = downscaleToFit(region, SEND_MAX_SIDE);
  let guide: string | undefined;
  if (guideCanvas) {
    const g = extractRegion(guideCanvas, rect, 'edge');
    guide = canvasToDataUrl(small === region ? g : resizeCanvas(g, small.width, small.height), 'image/jpeg', 0.9);
  }
  const resultUrl = await call(canvasToDataUrl(small, 'image/jpeg', 0.93), small.width, small.height, guide);
  const result = resizeCanvas(await loadImage(resultUrl), rect.w, rect.h);
  const out = createCanvas(flat.width, flat.height);
  ctx2d(out).drawImage(result, rect.x, rect.y);
  return out;
}

/**
 * Edits the image with Seedream. With a selection only a region around it is sent (padded to a supported
 * aspect ratio at native resolution), and only the masked pixels of the result are pasted back — with tone
 * matching against the untouched surroundings — so nothing outside the mask drifts, even after many passes.
 */
export async function runEdit(prompt: string) {
  const { doc, mask } = useEditor.getState();
  if (!doc || !prompt.trim()) return;
  const bounds = mask ? maskBounds(mask) : null;

  await withBusy(bounds ? 'Editing selection…' : 'Editing image…', async () => {
    const flat = flattenDoc(doc);
    const name = `Edit: ${prompt.slice(0, 32)}`;

    if (!bounds || !mask) {
      const result = await generateWholeImage(flat, (image, width, height) => apiEdit({ image, prompt, width, height }));
      useEditor.getState().addLayer(result, name);
      return;
    }

    // Region: selection + context margin, at least MIN_REGION, snapped to a supported ratio, kept inside the image.
    const margin = Math.max(48, Math.round(Math.max(bounds.w, bounds.h) * 0.35));
    let rect: Rect = { x: bounds.x - margin, y: bounds.y - margin, w: bounds.w + margin * 2, h: bounds.h + margin * 2 };
    const minSide = Math.min(MIN_REGION, Math.max(doc.width, doc.height));
    if (rect.w < minSide) rect = { ...rect, x: rect.x - (minSide - rect.w) / 2, w: minSide };
    if (rect.h < minSide) rect = { ...rect, y: rect.y - (minSide - rect.h) / 2, h: minSide };
    rect = expandRectToRatio(rect, nearestRatio(rect.w, rect.h));
    rect = roundRect(shiftRectIntoBounds(rect, doc.width, doc.height));

    const region = extractRegion(flat, rect, 'edge');
    const maskRegion = extractRegion(mask, rect, 'transparent');
    const { canvas: small } = downscaleToFit(region, SEND_MAX_SIDE);
    const smallMask = small === region ? maskRegion : resizeCanvas(maskRegion, small.width, small.height);
    const marked = buildMarkedImage(small, smallMask);
    const mb = maskBounds(maskRegion)!;
    const bbox: [number, number, number, number] = [
      (mb.x / rect.w) * 1000,
      (mb.y / rect.h) * 1000,
      ((mb.x + mb.w) / rect.w) * 1000,
      ((mb.y + mb.h) / rect.h) * 1000,
    ];

    const resultUrl = await apiEdit({
      image: canvasToDataUrl(small, 'image/jpeg', 0.93),
      marked: canvasToDataUrl(marked, 'image/jpeg', 0.93),
      bbox,
      prompt,
      width: small.width,
      height: small.height,
    });
    const result = resizeCanvas(await loadImage(resultUrl), rect.w, rect.h);
    matchTone(result, region, maskRegion);

    const soft = featherMask(dilateMask(maskRegion, 2), 3);
    const patch = compositeThroughMask(result, soft);
    const layer = createCanvas(doc.width, doc.height);
    ctx2d(layer).drawImage(patch, rect.x, rect.y);

    const state = useEditor.getState();
    state.addLayer(layer, name);
    state.resetMask();
  });
}

/**
 * Applies the crop/expand frame. Any part of the frame outside the current document is generated with the
 * hidden expand prompt; the generated pixels go on a layer underneath so the original stays pixel-exact.
 */
export async function runExpandCrop(rect: Rect) {
  const { doc } = useEditor.getState();
  if (!doc) return;
  const target = roundRect(rect);
  const newDoc = cropDoc(doc, target);
  const expands = target.x < 0 || target.y < 0 || target.x + target.w > doc.width || target.y + target.h > doc.height;

  if (!expands) {
    useEditor.getState().commit(newDoc, { fit: true });
    useEditor.getState().setPanel('menu');
    return;
  }

  await withBusy('Expanding image…', async () => {
    // Native outpainting: the model gets the ORIGINAL photo and the frame's aspect ratio and extends the scene
    // itself (same as choosing a different aspect ratio with the expand prompt in the WaveSpeed playground).
    // The model output IS the result; it is only cropped/scaled to the exact frame size, never stretched.
    const flat = flattenDoc(doc);
    const { canvas: small } = downscaleToFit(flat, SEND_MAX_SIDE);
    const resultUrl = await apiExpand({ image: canvasToDataUrl(small, 'image/jpeg', 0.93), width: target.w, height: target.h });
    const out = coverResize(await loadImage(resultUrl), target.w, target.h);
    const layer: Layer = { id: uid('layer'), name: 'AI expand', canvas: out, visible: true };
    const state = useEditor.getState();
    state.commit({ ...newDoc, layers: [...newDoc.layers.map((l) => ({ ...l, visible: false })), layer] }, { fit: true });
    state.setPanel('menu');
  });
}

/** Cut-out of `flat` with transparent background: server provider when configured, otherwise in-browser. */
async function removeBackgroundCanvas(flat: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const raw = await removeBackgroundRaw(flat);
  // Shave the halo of old background off the edge and soften it slightly.
  const minSide = Math.min(flat.width, flat.height);
  return refineAlpha(raw, Math.max(1, minSide * 0.0015), Math.max(1, minSide * 0.001));
}

async function removeBackgroundRaw(flat: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const serverResult = await apiRemoveBackground(canvasToDataUrl(flat, 'image/png'));
  if (serverResult) return resizeCanvas(await loadImage(serverResult), flat.width, flat.height);

  useEditor.getState().setBusy('Removing background (in browser, first run downloads the model)…');
  const { removeBackground } = await import('@imgly/background-removal');
  const blob = await new Promise<Blob>((res, rej) => flat.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
  let out: Blob;
  try {
    out = await removeBackground(blob, { output: { format: 'image/png', quality: 1 } });
  } catch (e) {
    throw new Error(
      `In-browser background removal failed (${(e as Error).message}). ` +
        'Set BG_REMOVAL_PROVIDER=wavespeed (or fal) in server/.env to run it server-side.',
    );
  }
  return resizeCanvas(await loadImageFromBlob(out), flat.width, flat.height);
}

export async function runRemoveBackground() {
  const { doc } = useEditor.getState();
  if (!doc) return;
  await withBusy('Removing background…', async () => {
    const cutout = await removeBackgroundCanvas(flattenDoc(doc));
    useEditor.getState().addLayer(cutout, 'Cutout', { hideOthers: true });
  });
}

/**
 * Replaces the background natively with Seedream: the model gets the whole photo and re-renders the scene
 * around the subject, so lighting, shadows and edges are consistent (no cut-and-paste seams).
 */
export async function runReplaceBackground(prompt: string) {
  const { doc } = useEditor.getState();
  if (!doc || !prompt.trim()) return;
  await withBusy('Replacing background…', async () => {
    const flat = flattenDoc(doc);
    const result = await generateWholeImage(flat, (image, width, height) => apiReplaceBackground({ image, prompt, width, height }));
    useEditor.getState().addLayer(result, `Background: ${prompt.slice(0, 28)}`);
    useEditor.getState().setPanel('menu');
  });
}

/** Adds a light source to the photo (direction, softness, brightness, colour) with Seedream; result = new layer. */
export async function runRelight(light: RelightSettings) {
  const { doc } = useEditor.getState();
  if (!doc) return;
  await withBusy('Relighting…', async () => {
    const flat = flattenDoc(doc);
    // The widget's light becomes a visual guide (glow from the chosen side, opposite side shaded) sent as image 2.
    const preview = renderLightPreview(flat, light);
    const result = await generateWholeImage(flat, (image, width, height, guide) => apiRelight({ image, guide, width, height, light }), preview);
    // Intensity also controls how much of the model's relight is applied on top of the original.
    const s = 0.35 + 0.65 * (light.brightness / 100);
    const out = createCanvas(doc.width, doc.height);
    const octx = ctx2d(out);
    octx.drawImage(flat, 0, 0);
    octx.globalAlpha = s;
    octx.drawImage(result, 0, 0);
    octx.globalAlpha = 1;
    useEditor.getState().addLayer(out, 'Re-consecration');
  });
}

/** Renders the grade at full resolution. */
export function renderGradeFullRes(params: GradeParams, match?: MatchInput): HTMLCanvasElement {
  const { doc } = useEditor.getState();
  if (!doc) throw new Error('No document');
  const flat = flattenDoc(doc);
  const ctx = ctx2d(flat);
  const img = ctx.getImageData(0, 0, flat.width, flat.height);
  ctx.putImageData(applyGrade(img, params, match), 0, 0);
  return flat;
}

export async function applyGradeAsLayer(params: GradeParams, match?: MatchInput) {
  await withBusy('Applying colour grade…', async () => {
    await new Promise((r) => setTimeout(r, 30)); // let the busy overlay paint before the heavy loop
    const c = renderGradeFullRes(params, match);
    const state = useEditor.getState();
    state.addLayer(c, 'Color Lab');
    state.setPanel('menu');
  });
}
