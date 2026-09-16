import { useEditor } from './store';
import type { ToolId } from './types';
import { IconBrush, IconEraser, IconHand, IconLasso, IconPointer, IconRect } from './Icons';

const TOOLS: { id: ToolId; label: string; Icon: (p: React.SVGProps<SVGSVGElement>) => JSX.Element }[] = [
  { id: 'select', label: 'Select (V)', Icon: IconPointer },
  { id: 'hand', label: 'Pan (H)', Icon: IconHand },
  { id: 'rect', label: 'Rectangle selection (M)', Icon: IconRect },
  { id: 'lasso', label: 'Lasso (L)', Icon: IconLasso },
  { id: 'brush', label: 'Mask brush (B)', Icon: IconBrush },
  { id: 'eraser', label: 'Mask eraser (E)', Icon: IconEraser },
];

/** Vertical tool rail on the left edge. */
export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const brushSize = useEditor((s) => s.brushSize);
  const setBrushSize = useEditor((s) => s.setBrushSize);
  const panel = useEditor((s) => s.panel);
  const disabled = panel === 'expandCrop';

  return (
    <nav className={`rail ${disabled ? 'disabled' : ''}`}>
      {TOOLS.map(({ id, label, Icon }, i) => (
        <span key={id} style={{ display: 'contents' }}>
          {i === 2 && <span className="divider" />}
          <button className={`tool ${tool === id ? 'active' : ''}`} title={label} onClick={() => setTool(id)}>
            <Icon />
          </button>
        </span>
      ))}
      {(tool === 'brush' || tool === 'eraser') && (
        <div className="brush-pop" title="Brush size ([ / ])">
          Size
          <input type="range" min={2} max={300} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
          <span>{brushSize}</span>
        </div>
      )}
    </nav>
  );
}
