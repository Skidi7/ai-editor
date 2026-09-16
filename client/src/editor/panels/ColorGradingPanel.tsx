import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import { applyGradeAsLayer, renderGradeFullRes } from '../actions';
import { createCanvas, ctx2d, downloadCanvas, downscaleToFit, flattenDoc, loadImageFromFile } from '../imageUtils';
import { DEFAULT_PARAMS, PRESETS, applyPreset, isIdentity, type GradeParams } from '../grading/params';
import { applyGrade, type MatchInput } from '../grading/process';
import { statsFromImageData, type MatchStats } from '../grading/colorMatch';
import { Slider, ToggleSection } from '../ui';
import { IconCheck, IconDownload, IconReset } from '../Icons';

const PREVIEW_SIDE = 720;

function imageDataOf(c: HTMLCanvasElement): ImageData {
  return ctx2d(c).getImageData(0, 0, c.width, c.height);
}

export function ColorGradingPanel() {
  const doc = useEditor((s) => s.doc);
  const setPreviewCanvas = useEditor((s) => s.setPreviewCanvas);
  const setPanel = useEditor((s) => s.setPanel);
  const busy = useEditor((s) => s.busy);

  const [params, setParams] = useState<GradeParams>(DEFAULT_PARAMS);
  const [presetId, setPresetId] = useState('none');
  const [refUrl, setRefUrl] = useState<string | null>(null);
  const [refStats, setRefStats] = useState<MatchStats | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const previewSrc = useMemo(() => {
    if (!doc) return null;
    const small = downscaleToFit(flattenDoc(doc), PREVIEW_SIDE).canvas;
    return { canvas: small, img: imageDataOf(small) };
  }, [doc]);

  const srcStats = useMemo(() => (previewSrc ? statsFromImageData(previewSrc.img) : null), [previewSrc]);
  const match: MatchInput | undefined = refStats && srcStats ? { src: srcStats, ref: refStats } : undefined;

  const thumbs = useMemo(() => {
    if (!previewSrc) return [];
    const tiny = downscaleToFit(previewSrc.canvas, 140).canvas;
    const img = imageDataOf(tiny);
    return PRESETS.map((p) => {
      const c = createCanvas(tiny.width, tiny.height);
      ctx2d(c).putImageData(applyGrade(img, applyPreset(DEFAULT_PARAMS, p)), 0, 0);
      return c.toDataURL('image/jpeg', 0.8);
    });
  }, [previewSrc]);

  // Live preview (debounced)
  useEffect(() => {
    if (!previewSrc) return;
    const id = window.setTimeout(() => {
      if (isIdentity(params) || (params.match && !match && !hasOtherEffects(params))) {
        setPreviewCanvas(null);
        return;
      }
      const c = createCanvas(previewSrc.canvas.width, previewSrc.canvas.height);
      ctx2d(c).putImageData(applyGrade(previewSrc.img, params, match), 0, 0);
      setPreviewCanvas(c);
    }, 40);
    return () => window.clearTimeout(id);
  }, [params, match, previewSrc, setPreviewCanvas]);

  useEffect(() => () => setPreviewCanvas(null), [setPreviewCanvas]);

  if (!doc) return null;

  const set = (patch: Partial<GradeParams>) => setParams((p) => ({ ...p, ...patch }));

  const choosePreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id)!;
    setPresetId(id);
    setParams((p) => applyPreset(p, preset));
  };

  const chooseReference = async (file: File) => {
    const img = await loadImageFromFile(file);
    const c = createCanvas(img.naturalWidth, img.naturalHeight);
    ctx2d(c).drawImage(img, 0, 0);
    const small = downscaleToFit(c, 400).canvas;
    setRefStats(statsFromImageData(imageDataOf(small)));
    setRefUrl(small.toDataURL('image/jpeg', 0.8));
    set({ match: true });
  };

  const reset = () => {
    setParams(DEFAULT_PARAMS);
    setPresetId('none');
    setRefStats(null);
    setRefUrl(null);
  };

  const download = () => {
    const c = renderGradeFullRes(params, match);
    downloadCanvas(c, 'graded.png');
  };

  const changed = !isIdentity(params);

  return (
    <div className="panel-body grading">
      <div className="card">
        <div className="card-title">Match reference</div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => e.target.files?.[0] && void chooseReference(e.target.files[0])}
        />
        {refUrl ? (
          <div className="ref">
            <img src={refUrl} alt="reference" />
            <div className="ref-controls">
              <Slider label="Strength" value={params.matchStrength} min={0} max={100} onChange={(v) => set({ matchStrength: v, match: true })} />
              <div className="row">
                <button className="ghost small" onClick={() => fileRef.current?.click()}>
                  Change
                </button>
                <button
                  className="ghost small"
                  onClick={() => {
                    setRefUrl(null);
                    setRefStats(null);
                    set({ match: false });
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button className="ghost wide" onClick={() => fileRef.current?.click()}>
            Choose a reference image
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-title">Looks</div>
        <div className="presets">
          {PRESETS.map((p, i) => (
            <button key={p.id} className={`preset ${presetId === p.id ? 'active' : ''}`} onClick={() => choosePreset(p.id)}>
              <span className="preset-thumb" style={{ backgroundImage: thumbs[i] ? `url(${thumbs[i]})` : undefined }}>
                {presetId === p.id && (
                  <span className="preset-check">
                    <IconCheck width={16} height={16} />
                  </span>
                )}
              </span>
              <span className="preset-name">{p.name}</span>
            </button>
          ))}
        </div>
      </div>

      <ToggleSection title="Color Correct" hint="White balance, saturation and contrast" enabled={params.colorCorrect} onToggle={(v) => set({ colorCorrect: v })}>
        <Slider label="Temperature" value={params.temperature} min={-100} max={100} onChange={(v) => set({ temperature: v })} />
        <Slider label="Tint" value={params.tint} min={-100} max={100} onChange={(v) => set({ tint: v })} />
        <Slider label="Saturation" value={params.saturation} min={-100} max={100} onChange={(v) => set({ saturation: v })} />
        <Slider label="Vibrance" value={params.vibrance} min={-100} max={100} onChange={(v) => set({ vibrance: v })} />
        <Slider label="Contrast" value={params.contrast} min={-100} max={100} onChange={(v) => set({ contrast: v })} />
      </ToggleSection>

      <ToggleSection title="Soften Details" hint="Gentle diffusion, smooths skin and texture" enabled={params.soften} onToggle={(v) => set({ soften: v })}>
        <Slider label="Amount" value={params.softenAmount} min={0} max={100} onChange={(v) => set({ softenAmount: v })} />
      </ToggleSection>

      <ToggleSection title="Lens Instructions" hint="Vignette, chromatic aberration and sharpening" enabled={params.lens} onToggle={(v) => set({ lens: v })}>
        <Slider label="Vignette" value={params.vignette} min={0} max={100} onChange={(v) => set({ vignette: v })} />
        <Slider label="Chromatic aberration" value={params.chromatic} min={0} max={100} onChange={(v) => set({ chromatic: v })} />
        <Slider label="Sharpen" value={params.sharpen} min={0} max={100} onChange={(v) => set({ sharpen: v })} />
      </ToggleSection>

      <ToggleSection title="Exposure" hint="Overall brightness, highlights and shadows" enabled={params.exposure} onToggle={(v) => set({ exposure: v })}>
        <Slider label="Exposure" value={params.exposureEv} min={-3} max={3} step={0.05} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`} onChange={(v) => set({ exposureEv: v })} />
        <Slider label="Highlights" value={params.highlights} min={-100} max={100} onChange={(v) => set({ highlights: v })} />
        <Slider label="Shadows" value={params.shadows} min={-100} max={100} onChange={(v) => set({ shadows: v })} />
      </ToggleSection>

      <ToggleSection title="Film Grain" hint="Analogue grain texture" enabled={params.grain} onToggle={(v) => set({ grain: v })}>
        <Slider label="Amount" value={params.grainAmount} min={0} max={100} onChange={(v) => set({ grainAmount: v })} />
        <Slider label="Size" value={params.grainSize} min={1} max={4} step={0.1} format={(v) => v.toFixed(1)} onChange={(v) => set({ grainSize: v })} />
      </ToggleSection>

      <div className="panel-footer">
        <button className="ghost" title="Reset" onClick={reset}>
          <IconReset />
        </button>
        <button className="ghost wide" disabled={!changed} onClick={download}>
          <IconDownload /> Download
        </button>
        <button className="accent" disabled={!changed || !!busy} onClick={() => void applyGradeAsLayer(params, match)}>
          Apply
        </button>
      </div>
      <button className="link" onClick={() => setPanel('menu')}>
        Back
      </button>
    </div>
  );
}

function hasOtherEffects(p: GradeParams): boolean {
  return isIdentity({ ...p, match: false }) === false;
}
