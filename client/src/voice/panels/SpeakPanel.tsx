import { useMemo } from 'react';
import { IconDownload, IconWave } from '../../editor/Icons';
import { Spinner } from '../../video/ui';
import { Card, PlayButton, Tags, VoiceAvatar } from '../components/common';
import { useVoice } from '../store';
import { detectLanguage, estimateSeconds, formatSeconds, hasWords, omniPrice, qwenPrice, splitText } from '../text';
import { ageLabel, usd, type HistoryItem } from '../types';

export const MAX_TEXT = 5000;

export function downloadName(h: HistoryItem): string {
  const words = h.text.replace(/[^\p{L}\p{N}\s-]/gu, '').trim().split(/\s+/).slice(0, 4).join('_').slice(0, 40);
  const ext = h.url.split('?')[0].split('.').pop() || 'wav';
  return `${h.voiceName.slice(0, 30)}-${words || 'voice'}.${ext}`.replace(/[\\/:*?"<>|\s]+/g, '_');
}

/** Result of the last generation on a tab: player (autoplays once, only on the visible tab) + download. */
export function ResultPlayer({ item, extra, autoPlay }: { item: HistoryItem | undefined; extra?: React.ReactNode; autoPlay: boolean }) {
  if (!item) return null;
  return (
    <div className="vc-result">
      <div className="vc-row">
        <b>Done</b>
        <span className="muted small">
          {item.voiceName} · {item.duration ? formatSeconds(item.duration) : ''} · {item.mock ? 'mock' : usd(item.cost)}
        </span>
        <span className="spacer" />
        {extra}
        <a className="btn small" href={item.url} download={downloadName(item)}>
          <IconDownload width={14} height={14} /> Download
        </a>
      </div>
      <audio key={item.id} className="vc-audio" controls autoPlay={autoPlay} src={item.url} />
    </div>
  );
}

export function SpeedControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="vc-speed">
      <span className="vs-field-label">Speed</span>
      <input type="range" min={0.5} max={2} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <b className="vc-speed-val">{value.toFixed(2)}×</b>
      {value !== 1 && (
        <button type="button" className="vs-linkbtn" onClick={() => onChange(1)}>
          reset
        </button>
      )}
    </div>
  );
}

/** Info line under a text box: language (from the text itself), length, duration, number of requests. */
export function TextStats({ text, speed }: { text: string; speed: number }) {
  const lang = useMemo(() => detectLanguage(text), [text]);
  const parts = useMemo(() => splitText(text).length, [text]);
  return (
    <div className="vc-stats">
      <span className={`vc-lang ${lang ? '' : 'none'}`} title="The voice reads the text in the language it is written in">
        {lang ? `Language: ${lang.label}` : 'Language is detected from the text'}
      </span>
      <span className={text.length > MAX_TEXT ? 'vc-over' : ''}>
        {text.length} / {MAX_TEXT} chars
      </span>
      {text.trim() && <span>≈ {formatSeconds(estimateSeconds(text, speed))}</span>}
      {parts > 1 && <span title="A long text is voiced in parts and joined into one file">{parts} parts</span>}
    </div>
  );
}

/** «Text to speech»: selected library voice + text → OmniVoice voice-clone of the voice's anchor clip. */
export function SpeakPanel({ active }: { active: boolean }) {
  const voice = useVoice((s) => s.voiceById(s.selectedId));
  const draft = useVoice((s) => s.draft);
  const setDraft = useVoice((s) => s.setDraft);
  const speed = useVoice((s) => s.speed);
  const setSpeed = useVoice((s) => s.setSpeed);
  const speaking = useVoice((s) => s.speaking);
  const preparing = useVoice((s) => s.preparing);
  const result = useVoice((s) => s.results.speak);
  const synthesize = useVoice((s) => s.synthesize);
  const mock = useVoice((s) => s.info?.provider === 'mock');
  const prices = useVoice((s) => s.prices());

  const chunks = useMemo(() => splitText(draft), [draft]);
  const cost = chunks.reduce((sum, c) => sum + omniPrice(c.length, prices), 0);
  const anchorCost = voice?.kind === 'preset' && !voice.sample ? qwenPrice(voice.sampleText.length, prices) : 0;
  const busy = speaking?.tab === 'speak';
  const blocked = !!speaking || !!preparing;

  const run = () => {
    if (!voice || !draft.trim()) return;
    void synthesize({ tab: 'speak', kind: 'speak', text: draft, speed, source: { voice } });
  };

  return (
    <div className="vc-panel">
      <Card title="Voice" hint="pick one in the library on the left">
        {voice ? (
          <div className="vc-selected">
            <VoiceAvatar name={voice.name} gender={voice.gender} size={56} />
            <div className="vc-selected-main">
              <div className="vc-selected-name">
                {voice.name}
                <span className="muted small">{[ageLabel(voice), voice.gender ?? ''].filter(Boolean).join(' · ')}</span>
              </div>
              <Tags items={[...voice.timbre, ...voice.manner]} />
              {(voice.useCase || voice.description) && <div className="muted small">{voice.useCase || voice.description}</div>}
              {voice.sampleText && <div className="vc-sample-text">“{voice.sampleText}”</div>}
            </div>
            <PlayButton url={voice.sample} size={44} title="Play the voice sample" disabledTitle="The sample is made on first use" />
          </div>
        ) : (
          <div className="vc-empty">No voice selected: click any voice in the library.</div>
        )}
      </Card>

      <Card title="Text" hint="any language: the voice reads it in the language of the text">
        <textarea
          className="vs-textarea vc-text"
          rows={8}
          value={draft}
          maxLength={MAX_TEXT + 500}
          placeholder="Paste or type the text to voice. Pauses: periods, ellipses, new paragraphs."
          onChange={(e) => setDraft(e.target.value)}
        />
        <TextStats text={draft} speed={speed} />
        <SpeedControl value={speed} onChange={setSpeed} />
      </Card>

      <button type="button" className="btn primary vc-go" disabled={!voice || !hasWords(draft) || draft.length > MAX_TEXT || blocked} onClick={run}>
        {busy ? (
          <>
            <Spinner small /> Generating{speaking && speaking.total > 1 ? ` · part ${Math.min(speaking.done + 1, speaking.total)} of ${speaking.total}` : '…'}
          </>
        ) : (
          <>
            <IconWave width={18} height={18} /> Generate speech · {mock ? 'mock, free' : usd(cost + anchorCost)}
            {anchorCost > 0 && !mock && <span className="vc-go-sub">including the voice sample {usd(anchorCost)}</span>}
          </>
        )}
      </button>
      {busy && speaking && speaking.total > 1 && (
        <div className="vs-progress">
          <span style={{ width: `${Math.round((speaking.done / speaking.total) * 100)}%` }} />
        </div>
      )}
      <ResultPlayer item={result} autoPlay={active} />

      <div className="vc-how">
        <b>How it works</b>
        <ol>
          <li>Every voice has a sample: a short phrase in that voice. Play it with the ▶ button.</li>
          <li>
            <b>OmniVoice</b> voices your text by repeating the voice from the sample: timbre, age and manner stay the same every time.
          </li>
          <li>The language comes from the text itself (600+ languages). A long text is split into parts and joined into one file.</li>
        </ol>
      </div>
    </div>
  );
}
