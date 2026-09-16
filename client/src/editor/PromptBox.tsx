import { useState, type CSSProperties } from 'react';
import { runEdit } from './actions';
import { useEditor } from './store';
import { IconClose, IconSparkle } from './Icons';

/** Floating prompt shown next to a selection — Seedream edits only the selected region. */
export function MaskPromptBox({ style, onClear }: { style: CSSProperties; onClear: () => void }) {
  const [prompt, setPrompt] = useState('');
  const busy = useEditor((s) => s.busy);

  const submit = () => {
    if (!prompt.trim() || busy) return;
    void runEdit(prompt);
    setPrompt('');
  };

  return (
    <div className="mask-prompt" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        autoFocus
        rows={2}
        placeholder="Type your prompt here…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') onClear();
        }}
      />
      <div className="mask-prompt-row">
        <button className="ghost small" title="Clear selection" onClick={onClear}>
          <IconClose width={16} height={16} />
        </button>
        <span className="model-chip">Seedream 5.0 Pro</span>
        <span className="spacer" />
        <button className="accent round" disabled={!prompt.trim() || !!busy} onClick={submit} title="Generate">
          <IconSparkle />
        </button>
      </div>
    </div>
  );
}

/** Bottom bar for whole-image edits (or the selection, when one exists). */
export function GlobalPromptBar() {
  const [prompt, setPrompt] = useState('');
  const busy = useEditor((s) => s.busy);
  const hasDoc = useEditor((s) => !!s.doc);

  const submit = () => {
    if (!prompt.trim() || busy || !hasDoc) return;
    void runEdit(prompt);
    setPrompt('');
  };

  return (
    <div className="prompt-bar">
      <input
        placeholder="Describe an edit for the whole image, or select an area first…"
        value={prompt}
        disabled={!hasDoc}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <button className="accent round" disabled={!prompt.trim() || !!busy || !hasDoc} onClick={submit} title="Generate">
        <IconSparkle />
      </button>
    </div>
  );
}
