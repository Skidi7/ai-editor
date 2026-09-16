import { useEditor } from '../store';
import { runRemoveBackground } from '../actions';
import { ExpandCropPanel } from './ExpandCropPanel';
import { ColorGradingPanel } from './ColorGradingPanel';
import { ReplaceBackgroundPanel } from './ReplaceBackgroundPanel';
import { RelightPanel } from './RelightPanel';
import { IconBack, IconBrush, IconCrop, IconGrade, IconRelight, IconRemoveBg } from '../Icons';

function FeatureCard({
  icon,
  name,
  desc,
  isNew,
  disabled,
  onClick,
}: {
  icon: JSX.Element;
  name: string;
  desc: string;
  isNew?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="feature-card" disabled={disabled} onClick={onClick}>
      <span className="feature-icon">{icon}</span>
      <span className="feature-name">{name}</span>
      <span className="feature-desc">{desc}</span>
      {isNew && <span className="badge">New</span>}
    </button>
  );
}

const TITLES: Record<string, string> = {
  expandCrop: 'Expand & Crop',
  colorGrading: 'Color Lab',
  replaceBg: 'Replace background',
  relight: 'Re-consecration',
};

/** Left tools panel: feature cards, or the open feature's controls. */
export function SidePanel() {
  const panel = useEditor((s) => s.panel);
  const setPanel = useEditor((s) => s.setPanel);
  const doc = useEditor((s) => s.doc);
  const setTool = useEditor((s) => s.setTool);
  const busy = useEditor((s) => s.busy);
  const serverInfo = useEditor((s) => s.serverInfo);

  return (
    <aside className="side">
      <div className="side-head">
        {panel !== 'menu' && (
          <button className="ghost small" onClick={() => setPanel('menu')} title="Back (Esc)">
            <IconBack />
          </button>
        )}
        <span className="side-title">{panel === 'menu' ? 'Tools' : TITLES[panel]}</span>
      </div>

      {panel === 'menu' && (
        <>
          <div className="section-label">AI tools</div>
          <div className="feature-grid">
            <FeatureCard icon={<IconBrush width={18} height={18} />} name="Magic edit" desc="Select an area and describe the change" disabled={!doc} onClick={() => setTool('brush')} />
            <FeatureCard icon={<IconCrop width={18} height={18} />} name="Expand & Crop" desc="Reframe or extend the scene" disabled={!doc} onClick={() => setPanel('expandCrop')} />
            <FeatureCard icon={<IconRemoveBg width={18} height={18} />} name="Remove background" desc="Cut the subject out" disabled={!doc || !!busy} onClick={() => void runRemoveBackground()} />
            <FeatureCard icon={<IconRemoveBg width={18} height={18} />} name="Replace background" desc="New scene from a prompt" isNew disabled={!doc} onClick={() => setPanel('replaceBg')} />
            <FeatureCard icon={<IconRelight width={18} height={18} />} name="Re-consecration" desc="Add a light source" isNew disabled={!doc} onClick={() => setPanel('relight')} />
          </div>
          <div className="section-label">Adjust</div>
          <div className="feature-grid">
            <FeatureCard icon={<IconGrade width={18} height={18} />} name="Color Lab" desc="Presets, tone and film looks" disabled={!doc} onClick={() => setPanel('colorGrading')} />
          </div>
          <div className="side-foot muted small">
            {serverInfo ? `Model: ${serverInfo.seedream} · BG removal: ${serverInfo.backgroundRemoval}` : 'Server offline — start `npm run dev`'}
          </div>
        </>
      )}
      {panel === 'expandCrop' && <ExpandCropPanel />}
      {panel === 'colorGrading' && <ColorGradingPanel />}
      {panel === 'replaceBg' && <ReplaceBackgroundPanel />}
      {panel === 'relight' && <RelightPanel />}
    </aside>
  );
}
