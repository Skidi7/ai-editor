import { useState } from 'react';
import { IconCheck, IconRefresh, IconSparkle } from '../../editor/Icons';
import { Spinner } from '../../video/ui';
import { apiDesign } from '../api';
import { Card, PlayButton, Tags } from '../components/common';
import { SaveVoiceDialog, type SaveInitial } from '../components/SaveVoiceDialog';
import { useVoice } from '../store';
import { qwenPrice } from '../text';
import { usd, type DesignResult } from '../types';

const IDEAS = [
  { label: 'Late-night radio host', text: 'A woman around 30, low warm voice with a slight rasp, relaxed and a little lazy, like a late-night radio host' },
  { label: 'British storyteller', text: 'A woman around 35 with a warm British accent and a rich low voice, telling a bedtime story slowly and expressively' },
  { label: 'Southern charm', text: 'A woman around 28 from Georgia with a sweet Southern drawl, friendly, laid-back and a little flirty' },
  { label: 'Stand-up comic', text: 'A woman around 30, bright confident voice, fast and funny, like a stand-up comedian' },
  { label: 'Perfume ad', text: 'A 35-year-old woman, deep velvety voice, confident and a little mysterious, like a perfume commercial' },
];

/** Phrase length the AI usually writes, for the price shown before the first take. */
const TYPICAL_PHRASE = 120;

/** One cast voice and its takes: every take says the same phrase from the same description. */
interface Session {
  request: string;
  result: DesignResult;
  takes: { id: string; url: string }[];
}

/**
 * «Create voice»: a description in plain words → the AI casts the voice and records a take (Qwen3 Voice Design) →
 * another take of the same voice, or save the one you like.
 */
export function DesignPanel() {
  const mock = useVoice((s) => s.info?.provider === 'mock');
  const prices = useVoice((s) => s.prices());
  const addSpent = useVoice((s) => s.addSpent);
  const setError = useVoice((s) => s.setError);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState<'new' | 'again' | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [dialog, setDialog] = useState<SaveInitial | null>(null);

  const request = description.trim();
  const newCost = prices.llmPerRun + qwenPrice(TYPICAL_PHRASE, prices);
  const againCost = session ? qwenPrice(session.result.sampleText.length, prices) : 0;
  // A take belongs to the description it was made from: after an edit, "Create voice" casts a new one.
  const canAgain = !!session && session.request === request;

  const run = async (again: boolean) => {
    if (!request || busy) return;
    setBusy(again ? 'again' : 'new');
    try {
      const r = await apiDesign({ description: request, again: again ? session?.result.id : undefined });
      addSpent(r.cost);
      setSession((s) => (s && s.result.id === r.id ? { ...s, takes: [...s.takes, r.take] } : { request, result: r, takes: [r.take] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openSave = (url: string) => {
    if (!session) return;
    const s = session.result.spec;
    setDialog({
      name: s.name,
      gender: s.gender,
      age: s.age,
      timbre: s.timbre,
      manner: s.manner,
      description: session.request,
      sample: url,
      sampleText: session.result.sampleText,
      source: 'design',
    });
  };

  const spec = session?.result.spec;

  return (
    <div className="vc-panel">
      <Card title="Describe the voice" hint="in plain words, any language: age, voice, accent, manner">
        <textarea
          className="vs-textarea"
          rows={3}
          value={description}
          maxLength={1200}
          placeholder="For example: a woman around 35 with a velvety low voice and a soft Irish accent, calm and confiding, like a podcast host"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="vc-row">
          <span className="muted small">Ideas:</span>
          {IDEAS.map((idea) => (
            <button key={idea.label} type="button" className="vc-chip" title={idea.text} onClick={() => setDescription(idea.text)}>
              {idea.label}
            </button>
          ))}
        </div>
      </Card>

      <button type="button" className="btn primary vc-go" disabled={!request || !!busy} onClick={() => void run(false)}>
        {busy === 'new' ? (
          <>
            <Spinner small /> Creating the voice… (10–30 s)
          </>
        ) : (
          <>
            <IconSparkle width={18} height={18} /> Create voice · {mock ? 'mock, free' : `≈ ${usd(newCost)}`}
          </>
        )}
      </button>

      {session && spec && (
        <Card title={spec.name ? `Result: ${spec.name}` : 'Result'} hint={session.result.mock ? 'mock mode: synthetic sound instead of a voice' : undefined}>
          <Tags items={[...spec.timbre, ...spec.manner]} />
          <div className="vc-sample-text">
            “{session.result.sampleText}”{session.result.language !== 'English' && <span className="muted small"> · {session.result.language}</span>}
          </div>
          <div className="vc-variants">
            {session.takes.map((t, i) => (
              <div key={t.id} className="vc-variant">
                <PlayButton url={t.url} size={38} />
                <b>Take {i + 1}</b>
                <span className="spacer" />
                {saved.includes(t.url) ? (
                  <span className="vc-saved">
                    <IconCheck width={14} height={14} /> in my voices
                  </span>
                ) : (
                  <button type="button" className="btn small" onClick={() => openSave(t.url)}>
                    Save to my voices
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="vc-row">
            <button
              type="button"
              className="btn"
              disabled={!canAgain || !!busy}
              title={canAgain ? 'The same voice description, recorded once more: every take comes out a little different' : 'The description has changed: press “Create voice”'}
              onClick={() => void run(true)}
            >
              {busy === 'again' ? (
                <>
                  <Spinner small /> Recording another take…
                </>
              ) : (
                <>
                  <IconRefresh width={14} height={14} /> Another take · {mock ? 'mock, free' : usd(againCost)}
                </>
              )}
            </button>
            <span className="muted small">Every take comes out a little different: save the one you like.</span>
          </div>
          <details className="vc-details">
            <summary>What was sent to the model</summary>
            <div className="small">
              {spec.description}
              <div className="muted">Qwen3 TTS Voice Design · description {spec.via === 'llm' ? 'written by the AI from your words' : 'made from your words as they are'}</div>
            </div>
          </details>
        </Card>
      )}

      <div className="vc-how">
        <b>How it works</b>
        <ol>
          <li>Describe the voice the way you'd brief a voice actor. Any language works.</li>
          <li>The AI casts the voice and records a short phrase in character. Not quite right? Record another take or change the description.</li>
          <li>Save the take you like: from then on it voices any text, and always sounds the same.</li>
        </ol>
      </div>

      {dialog && <SaveVoiceDialog initial={dialog} onClose={() => setDialog(null)} onSaved={() => setSaved((s) => [...s, dialog.sample])} />}
    </div>
  );
}
