import { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { runExpandCrop } from '../actions';
import { IconInfo } from '../Icons';

interface RatioDef {
  label: string;
  r: number;
}
const PORTRAIT: RatioDef[] = [
  { label: '4:5', r: 4 / 5 },
  { label: '3:4', r: 3 / 4 },
  { label: '2:3', r: 2 / 3 },
  { label: '9:16', r: 9 / 16 },
];
const LANDSCAPE: RatioDef[] = [
  { label: '5:4', r: 5 / 4 },
  { label: '4:3', r: 4 / 3 },
  { label: '3:2', r: 3 / 2 },
  { label: '16:9', r: 16 / 9 },
];
const SQUARE: RatioDef = { label: '1:1', r: 1 };

function RatioChip({ def, active, onClick }: { def: RatioDef; active: boolean; onClick: () => void }) {
  const w = def.r >= 1 ? 22 : 22 * def.r;
  const h = def.r >= 1 ? 22 / def.r : 22;
  return (
    <button className={`ratio-chip ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="ratio-icon" style={{ width: w, height: h }} />
      <span>{def.label}</span>
    </button>
  );
}

export function ExpandCropPanel() {
  const doc = useEditor((s) => s.doc);
  const cropRect = useEditor((s) => s.cropRect);
  const setCropRect = useEditor((s) => s.setCropRect);
  const setPanel = useEditor((s) => s.setPanel);
  const busy = useEditor((s) => s.busy);
  const requestFit = useEditor((s) => s.requestFit);
  const [mode, setMode] = useState<'expand' | 'crop'>('expand');
  const [activeRatio, setActiveRatio] = useState<string | null>(null);

  useEffect(() => {
    if (doc) setCropRect({ x: 0, y: 0, w: doc.width, h: doc.height });
    return () => {
      setCropRect(null);
      // The view was fitted around the frame; refit around the document when leaving the tool.
      window.setTimeout(requestFit, 0);
    };
  }, [doc, setCropRect, requestFit]);

  if (!doc) return null;

  const expands =
    !!cropRect && (cropRect.x < 0 || cropRect.y < 0 || cropRect.x + cropRect.w > doc.width || cropRect.y + cropRect.h > doc.height);
  const unchanged = !!cropRect && cropRect.x === 0 && cropRect.y === 0 && cropRect.w === doc.width && cropRect.h === doc.height;

  /** Expand: smallest frame with the ratio that contains the image. Crop: largest frame with the ratio inside it. */
  const applyRatio = (def: RatioDef, m = mode) => {
    let w = doc.width;
    let h = doc.height;
    const wantWider = w / h < def.r;
    if (m === 'expand') {
      if (wantWider) w = Math.round(h * def.r);
      else h = Math.round(w / def.r);
    } else {
      if (wantWider) h = Math.round(w / def.r);
      else w = Math.round(h * def.r);
    }
    setCropRect({ x: Math.round((doc.width - w) / 2), y: Math.round((doc.height - h) / 2), w, h });
    setActiveRatio(def.label);
    window.setTimeout(requestFit, 0);
  };

  const switchMode = (m: 'expand' | 'crop') => {
    setMode(m);
    const def = [...PORTRAIT, SQUARE, ...LANDSCAPE].find((d) => d.label === activeRatio);
    if (def) applyRatio(def, m);
  };

  const setSize = (patch: { w?: number; h?: number }) => {
    if (!cropRect) return;
    setCropRect({ ...cropRect, ...patch });
    setActiveRatio(null);
  };

  return (
    <div className="panel-body">
      <div className="how">
        <div className="how-title">
          <IconInfo width={14} height={14} /> HOW IT WORKS
        </div>
        <p>
          Drag the edges or corners of the frame, or pick a ratio. Everything inside the frame is kept; any area
          outside the photo is generated with AI to continue the scene.
        </p>
      </div>

      <div className="segmented">
        <button className={mode === 'expand' ? 'active' : ''} onClick={() => switchMode('expand')}>
          Expand
        </button>
        <button className={mode === 'crop' ? 'active' : ''} onClick={() => switchMode('crop')}>
          Crop
        </button>
      </div>

      <div className="ratio-group">
        <div className="ratio-label">Portrait</div>
        <div className="ratio-row">
          {PORTRAIT.map((d) => (
            <RatioChip key={d.label} def={d} active={activeRatio === d.label} onClick={() => applyRatio(d)} />
          ))}
        </div>
      </div>
      <div className="ratio-group">
        <div className="ratio-label">Square & landscape</div>
        <div className="ratio-row">
          {[SQUARE, ...LANDSCAPE].map((d) => (
            <RatioChip key={d.label} def={d} active={activeRatio === d.label} onClick={() => applyRatio(d)} />
          ))}
        </div>
      </div>

      {cropRect && (
        <div className="dims">
          <label>
            W <input type="number" value={cropRect.w} min={16} onChange={(e) => setSize({ w: Math.max(16, Number(e.target.value) || 16) })} />
          </label>
          <label>
            H <input type="number" value={cropRect.h} min={16} onChange={(e) => setSize({ h: Math.max(16, Number(e.target.value) || 16) })} />
          </label>
        </div>
      )}

      <p className="muted small">
        {expands ? 'Areas outside the photo will be generated with Seedream to match the original.' : 'Only pixels inside the frame will be kept.'}
      </p>

      <div className="panel-actions">
        <button className="ghost" onClick={() => setPanel('menu')}>
          Cancel
        </button>
        <button className="accent" disabled={!cropRect || unchanged || !!busy} onClick={() => cropRect && void runExpandCrop(cropRect)}>
          {expands ? 'Expand' : 'Crop'}
        </button>
      </div>
    </div>
  );
}
