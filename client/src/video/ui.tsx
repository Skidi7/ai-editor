import { useRef, type ReactNode } from 'react';

/** Labelled control. A div, not a label: nested labels break range sliders and checkboxes inside. */
export function Field({ label, hint, children, row }: { label: string; hint?: string; children: ReactNode; row?: boolean }) {
  return (
    <div className={`vs-field ${row ? 'row' : ''}`}>
      <span className="vs-field-label">
        {label}
        {hint && <span className="vs-field-hint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, small }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`vs-seg ${small ? 'small' : ''}`}>
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function UploadButton({
  accept,
  onFile,
  className,
  children,
  title,
  disabled,
}: {
  accept: string;
  onFile: (file: File) => void;
  className?: string;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <button type="button" className={className || 'ghost'} title={title} disabled={disabled} onClick={() => ref.current?.click()}>
        {children}
      </button>
    </>
  );
}

export function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function Badge({ kind, children }: { kind: 'idle' | 'generating' | 'ready' | 'error' | 'stale' | 'info'; children: ReactNode }) {
  return <span className={`vs-badge ${kind}`}>{children}</span>;
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={`vs-spin ${small ? 'small' : ''}`} />;
}
