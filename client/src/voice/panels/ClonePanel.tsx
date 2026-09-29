import { useEffect, useMemo, useState } from 'react';
import { IconCopy, IconPlus } from '../../editor/Icons';
import { Spinner } from '../../video/ui';
import { Card } from '../components/common';
import { ReferencePicker, useReference } from '../components/Reference';
import { SaveVoiceDialog, type SaveInitial } from '../components/SaveVoiceDialog';
import { useVoice } from '../store';
import { hasWords, omniPrice, splitText } from '../text';
import { usd, type VoiceSource } from '../types';
import { MAX_TEXT, ResultPlayer, SpeedControl, TextStats } from './SpeakPanel';

/** The sample behind the result on screen: "Save to my voices" saves exactly it, and a different fragment hides the result. */
interface Run {
  id: string;
  sample: string;
  sampleText: string;
  fragKey: string;
  source: VoiceSource;
  /** File the voice was taken from, for the note in the library. */
  file: string;
}

/** First words for a voice sent over from «Capture voice», so it can be heard with one click (under 100 characters). */
const TRY_TEXT = 'Hi there! This is a quick test of this voice. Type any text here and listen again.';

/** «Voice clone»: your own recording or file + text → the text spoken in that voice (OmniVoice voice-clone). */
export function ClonePanel({ active }: { active: boolean }) {
  const ref = useReference({ clean: false });
  const synthesize = useVoice((s) => s.synthesize);
  const speaking = useVoice((s) => s.speaking);
  const result = useVoice((s) => s.results.clone);
  const mock = useVoice((s) => s.info?.provider === 'mock');
  const prices = useVoice((s) => s.prices());
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState(1);
  const [dialog, setDialog] = useState<SaveInitial | null>(null);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const handoff = useVoice((s) => s.handoff);
  const takeHandoff = useVoice((s) => s.takeHandoff);

  // A voice sent from «Capture voice»: take over its file and fragment, and suggest a first phrase to hear it.
  useEffect(() => {
    const h = handoff && takeHandoff();
    if (!h) return;
    ref.adopt(h);
    setText((t) => (t.trim() ? t : TRY_TEXT));
  }, [handoff]);

  const chunks = useMemo(() => splitText(text), [text]);
  const cost = chunks.reduce((sum, c) => sum + omniPrice(c.length, prices), 0) + ref.prepareCost;
  const busy = speaking?.tab === 'clone';
  const shown = lastRun && result?.id === lastRun.id && lastRun.fragKey === ref.fragKey ? result : undefined;

  const run = async () => {
    try {
      const fragKey = ref.fragKey;
      const source: VoiceSource = ref.source?.kind === 'mic' ? 'mic' : ref.origin === 'capture' ? 'capture' : 'clone';
      const file = ref.source?.kind === 'mic' ? '' : ref.source?.name ?? '';
      const { sample, text: refText } = await ref.prepare();
      const item = await synthesize({ tab: 'clone', kind: 'clone', text, speed, source: { sample: sample.url, sampleText: refText, name: source === 'mic' ? 'My voice' : 'Cloned voice' } });
      if (item) setLastRun({ id: item.id, sample: sample.url, sampleText: refText, fragKey, source, file });
    } catch {
      /* shown by the picker */
    }
  };

  const save = () => {
    if (!lastRun) return;
    setDialog({
      name: '',
      gender: null,
      age: null,
      timbre: [],
      manner: [],
      description: lastRun.source === 'capture' && lastRun.file ? `From file: ${lastRun.file}` : '',
      sample: lastRun.sample,
      sampleText: lastRun.sampleText,
      source: lastRun.source,
    });
  };

  return (
    <div className="vc-panel">
      <Card title="1. Voice sample" hint={ref.origin === 'capture' ? 'taken in Capture voice' : 'your recording or a file'}>
        <ReferencePicker
          state={ref}
          active={active}
          intro="6–15 seconds of clean speech. You can record it right here: press “Record with microphone” and read a short text."
        />
      </Card>

      <Card title="2. What to say in this voice">
        <textarea
          className="vs-textarea vc-text"
          rows={6}
          value={text}
          maxLength={MAX_TEXT + 500}
          placeholder="Text in any language: the voice from the sample reads it in the language of the text."
          onChange={(e) => setText(e.target.value)}
        />
        <TextStats text={text} speed={speed} />
        <SpeedControl value={speed} onChange={setSpeed} />
      </Card>

      <button
        type="button"
        className="btn primary vc-go"
        disabled={!ref.source || ref.tooShort || !hasWords(text) || text.length > MAX_TEXT || !!speaking || !!ref.busy}
        title={ref.prepareNote || undefined}
        onClick={() => void run()}
      >
        {busy || ref.busy ? (
          <>
            <Spinner small /> {ref.busy || (speaking && speaking.total > 1 ? `Generating · part ${Math.min(speaking.done + 1, speaking.total)} of ${speaking.total}` : 'Generating…')}
          </>
        ) : (
          <>
            <IconCopy width={18} height={18} /> Speak in this voice · {mock ? 'mock, free' : usd(cost)}
          </>
        )}
      </button>
      {!ref.source && <div className="muted small center">Add a voice sample first.</div>}
      {ref.tooShort && <div className="muted small center">The selected fragment is too short: select at least 3 seconds.</div>}

      <ResultPlayer
        item={shown}
        autoPlay={active}
        extra={
          <button type="button" className="btn small" onClick={save} title="Save the voice that produced this result">
            <IconPlus width={14} height={14} /> Save to my voices
          </button>
        }
      />

      <div className="vc-how">
        <b>How it works</b>
        <ol>
          <li>
            <b>OmniVoice</b> listens to the sample and says your text in the same voice. The words of the sample are recognised automatically, once: with
            them the voice comes out noticeably closer.
          </li>
          <li>A good sample: one voice, no music or echo, natural intonation. The sample's intonation carries over into the speech.</li>
          <li>Like it? Press “Save to my voices” and it appears in the library under My voices, ready for any text.</li>
        </ol>
      </div>

      {dialog && <SaveVoiceDialog initial={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
