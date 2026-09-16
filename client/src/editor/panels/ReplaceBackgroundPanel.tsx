import { useState } from 'react';
import { useEditor } from '../store';
import { runReplaceBackground } from '../actions';
import { IconInfo, IconSparkle } from '../Icons';

const SUGGESTIONS = ['Sunny beach at golden hour', 'Modern loft studio, soft window light', 'Neon city street at night', 'Plain white studio backdrop'];

export function ReplaceBackgroundPanel() {
  const [prompt, setPrompt] = useState('');
  const busy = useEditor((s) => s.busy);
  const setPanel = useEditor((s) => s.setPanel);

  const submit = () => {
    if (!prompt.trim() || busy) return;
    void runReplaceBackground(prompt);
  };

  return (
    <div className="panel-body">
      <div className="how">
        <div className="how-title">
          <IconInfo width={14} height={14} /> HOW IT WORKS
        </div>
        <p>
          Describe the new background. Seedream re-renders the scene around the subject with matching light,
          shadows and perspective, so the result looks like one real photo. The result is added as a new layer.
        </p>
      </div>

      <textarea
        className="prompt-area"
        rows={4}
        autoFocus
        placeholder="Describe the new background…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <div className="ratio-row">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" onClick={() => setPrompt(s)}>
            {s}
          </button>
        ))}
      </div>

      <div className="panel-actions">
        <button className="ghost" onClick={() => setPanel('menu')}>
          Cancel
        </button>
        <button className="accent" disabled={!prompt.trim() || !!busy} onClick={submit}>
          <IconSparkle width={18} height={18} /> Replace background
        </button>
      </div>
    </div>
  );
}
