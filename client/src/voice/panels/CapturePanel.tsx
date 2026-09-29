import { useState } from 'react';
import { IconCopy, IconPlus } from '../../editor/Icons';
import { Spinner } from '../../video/ui';
import { Card } from '../components/common';
import { ReferencePicker, useReference } from '../components/Reference';
import { SaveVoiceDialog, type SaveInitial } from '../components/SaveVoiceDialog';
import { useVoice } from '../store';
import { usd } from '../types';

/**
 * «Capture voice»: a voice from any audio or video (interview, clip, voice message) → a clean fragment → tried out in
 * «Voice clone» with any text, or saved to the library straight away.
 */
export function CapturePanel({ active }: { active: boolean }) {
  const ref = useReference({ clean: true });
  const sendToClone = useVoice((s) => s.sendToClone);
  const mock = useVoice((s) => s.info?.provider === 'mock');
  const [dialog, setDialog] = useState<SaveInitial | null>(null);

  const working = !!ref.busy;
  const blocked = working || ref.tooShort;
  const prepCost = mock ? 'mock' : usd(ref.prepareCost);

  const save = async () => {
    try {
      const { sample, text } = await ref.prepare();
      setDialog({
        name: '',
        gender: null,
        age: null,
        timbre: [],
        manner: [],
        description: ref.source ? `From file: ${ref.source.name}` : '',
        sample: sample.url,
        sampleText: text,
        source: ref.source?.kind === 'mic' ? 'mic' : 'capture',
      });
    } catch {
      /* shown by the picker */
    }
  };

  const tryInClone = () => {
    const h = ref.snapshot();
    if (h) sendToClone(h);
  };

  return (
    <div className="vc-panel">
      <Card title="1. Where to take the voice from" hint="video or audio">
        <ReferencePicker
          state={ref}
          active={active}
          intro="An interview, a clip, a podcast, a voice message. We pull the audio straight out of the video and can remove the music."
        />
      </Card>

      {ref.source && (
        <Card title="2. Use the voice">
          <div className="vc-row">
            <button type="button" className="btn primary" disabled={blocked} onClick={tryInClone} title="Opens Voice clone with this fragment: type any text and hear it in this voice">
              <IconCopy width={16} height={16} /> Try it in Voice clone
            </button>
            <button type="button" className="btn" disabled={blocked} onClick={() => void save()} title={ref.prepareNote || undefined}>
              <IconPlus width={16} height={16} /> Save to my voices{ref.prepareCost > 0 || mock ? ` · ${prepCost}` : ''}
            </button>
            {working && <Spinner small />}
          </div>
          {ref.tooShort ? (
            <div className="muted small">The selected fragment is too short: select at least 3 seconds.</div>
          ) : (
            <div className="muted small">Try it first: in Voice clone you type any text, hear it in this voice, and save the voice if you like it.</div>
          )}
        </Card>
      )}

      <div className="vc-how">
        <b>Tips</b>
        <ol>
          <li>Pick a spot where one person talks, without laughter or interruptions: 6–15 seconds is enough.</li>
          <li>“Remove background music” separates the voice from music and noise. Turn it off for a clean recording: it costs less.</li>
          <li>Only save your own voice or the voice of someone who agreed to it.</li>
        </ol>
      </div>

      {dialog && <SaveVoiceDialog initial={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
