import { useMemo, useRef } from 'react';
import { addImageFileAsLayer, useEditor } from '../store';
import { thumbnailUrl } from '../imageUtils';
import type { Layer } from '../types';
import { IconEye, IconEyeOff, IconLayers, IconPlus, IconTrash } from '../Icons';

function LayerRow({ layer, canDelete }: { layer: Layer; canDelete: boolean }) {
  const toggleLayer = useEditor((s) => s.toggleLayer);
  const removeLayer = useEditor((s) => s.removeLayer);
  const thumb = useMemo(() => thumbnailUrl(layer.canvas, 64), [layer.canvas]);
  return (
    <div className={`layer ${layer.visible ? '' : 'hidden'}`}>
      <span className="layer-thumb" style={{ backgroundImage: `url(${thumb})` }} />
      <span className="layer-name" title={layer.name}>
        {layer.name}
      </span>
      <span className="spacer" />
      <button className="ghost small" title={layer.visible ? 'Hide' : 'Show'} onClick={() => toggleLayer(layer.id)}>
        {layer.visible ? <IconEye width={16} height={16} /> : <IconEyeOff width={16} height={16} />}
      </button>
      {canDelete && (
        <button className="ghost small" title="Delete layer" onClick={() => removeLayer(layer.id)}>
          <IconTrash width={16} height={16} />
        </button>
      )}
    </div>
  );
}

export function LayersPanel() {
  const doc = useEditor((s) => s.doc);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!doc)
    return (
      <div className="layers">
        <div className="section-label">
          <IconLayers width={16} height={16} /> Layers
        </div>
        <div className="muted small" style={{ padding: '4px 14px' }}>
          Open an image to see layers.
        </div>
      </div>
    );
  const layers = [...doc.layers].reverse();
  return (
    <div className="layers">
      <div className="section-label">
        <IconLayers width={16} height={16} /> Layers
        <span className="spacer" />
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void addImageFileAsLayer(e.target.files[0])} />
        <button className="ghost small" title="Add image as layer" onClick={() => fileRef.current?.click()}>
          <IconPlus width={16} height={16} />
        </button>
      </div>
      {layers.map((l) => (
        <LayerRow key={l.id} layer={l} canDelete={doc.layers.length > 1} />
      ))}
    </div>
  );
}
