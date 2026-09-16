import { useState, type ReactNode } from 'react';
import { IconChevron, IconInfo } from './Icons';

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="knob" />
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{label}</span>
        <span className="slider-value">{format ? format(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/** Collapsible row with a switch in the header (Color Correct, Bloom, ...). */
export function ToggleSection({
  title,
  hint,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  hint?: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`section ${open ? 'open' : ''}`}>
      <div className="section-head" onClick={() => setOpen((o) => !o)}>
        <IconChevron className="chev" width={16} height={16} />
        <span className="section-title">{title}</span>
        {hint && (
          <span className="hint" title={hint}>
            <IconInfo width={14} height={14} />
          </span>
        )}
        <span className="spacer" />
        <Toggle
          checked={enabled}
          onChange={(v) => {
            onToggle(v);
            if (v) setOpen(true);
          }}
        />
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}
