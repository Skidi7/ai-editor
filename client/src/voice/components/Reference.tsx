import { useEffect, useRef, useState } from 'react';
import { IconClose, IconMic, IconPause, IconPlay, IconUpload, IconWand } from '../../editor/Icons';
import { Spinner } from '../../video/ui';
import { apiExtract, apiIsolate, apiTranscribe, apiUpload } from '../api';
import { MicRecorder, RangePlayer, SAMPLE_RATE, bestFragment, cutFragment, decodeAudio, decodeUrl, encodeWav, keepPhrases, peakOf, tightenPauses, toMono } from '../audio';
import { useVoice } from '../store';
import { formatClock, formatSeconds, perSecond } from '../text';
import { DEFAULT_PRICES, usd, type PreparedSample } from '../types';
import { PlayButton } from './common';
import { Waveform, type Range } from './Waveform';

export interface RefSource {
  name: string;
  kind: 'audio' | 'video' | 'mic';
  buffer: AudioBuffer;
  mono: Float32Array;
  duration: number;
}

export const MIC_SCRIPT =
  "Today is a great day to try something new. I'm reading this text calmly and naturally, just like talking to a friend.";

const MAX_FILE = 600 * 1024 * 1024;
const MAX_RECORD_SEC = 30;

/** Shorter samples do not carry enough of a voice to clone it. */
export const MIN_SAMPLE_SEC = 3;

/** Who filled in the words of a fragment: Whisper, or the reading script of a microphone recording. */
type TextOf = { key: string; by: 'auto' | 'script' };

/**
 * Everything a picker knows about its file: handed from «Capture voice» to «Voice clone», including what was already
 * paid for (the cleaned clip, the words Whisper heard), so nothing is paid twice.
 */
export interface RefHandoff {
  source: RefSource;
  sel: Range;
  clean: boolean;
  transcript: string;
  textOf: TextOf | null;
  silent: string[];
  heard: Record<string, string>;
  prepared: (PreparedSample & { key: string }) | null;
}

/** A fragment of one particular loaded file (the load number tells apart two files with the same name and length). */
const fragmentKey = (load: number, name: string, duration: number, r: Range) => `${load}|${name}|${duration}|${r.start.toFixed(2)}|${r.end.toFixed(2)}`;

/**
 * State of a reference clip (voice capture / voice clone): the decoded file, the selected fragment, the music option,
 * and `prepare()` which cuts the fragment, uploads it, removes music if asked (Audio Vocal Isolator) and recognises its
 * words (Whisper). The words are not shown: OmniVoice clones noticeably closer with the exact words of the sample, and
 * their timings trim the sample to the speech. Each paid step runs once per fragment.
 */
export function useReference(defaults: { clean: boolean }) {
  const info = useVoice((s) => s.info);
  const addSpent = useVoice((s) => s.addSpent);
  const [source, setSource] = useState<RefSource | null>(null);
  const [sel, setSel] = useState<Range>({ start: 0, end: 0 });
  const [clean, setClean] = useState(defaults.clean);
  const [transcript, setTranscriptText] = useState('');
  /** Which fragment the words belong to, and where they come from: Whisper or the reading script. */
  const [textOf, setTextOf] = useState<TextOf | null>(null);
  /** Fragments in which Whisper heard no words: not transcribed (and paid for) again. */
  const [silent, setSilent] = useState<string[]>([]);
  /** Words Whisper already heard, per fragment: coming back to a fragment restores them instead of paying again. */
  const [heard, setHeard] = useState<Record<string, string>>({});
  const [loadNo, setLoadNo] = useState(0);
  const loads = useRef(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState<(PreparedSample & { key: string }) | null>(null);
  /** Where the file came from: loaded or recorded here, or handed over from «Capture voice». */
  const [origin, setOrigin] = useState<'own' | 'capture'>('own');

  const fragKey = source ? fragmentKey(loadNo, source.name, source.duration, sel) : '';
  const key = `${fragKey}|${clean ? 1 : 0}`;
  const fresh = prepared && prepared.key === key ? prepared : null;
  const seconds = Math.max(0, sel.end - sel.start);
  const heardNothing = silent.includes(fragKey);
  const prices = info?.prices ?? DEFAULT_PRICES;
  const mock = info?.provider === 'mock';
  const cleanCost = clean && !fresh ? perSecond(seconds, prices.isolatePerSecond) : 0;
  const textCost = !transcript.trim() && !heardNothing ? perSecond(seconds, prices.whisperTimedPerSecond) : 0;
  const prepareCost = mock ? 0 : cleanCost + textCost;
  /** What the one-time preparation pays for, for the price tooltips. */
  const prepareNote = prepareCost
    ? `Includes a one-time ${usd(prepareCost)} to prepare this voice: ${[cleanCost && `removing music ${usd(cleanCost)}`, textCost && `recognising its words ${usd(textCost)}`].filter(Boolean).join(', ')}. After that each phrase costs only the speech.`
    : '';

  // Words describe their own fragment only: moving the selection swaps in that fragment's words if Whisper already
  // heard them, or clears them, so they are recognised again for the new fragment.
  useEffect(() => {
    if (textOf && textOf.key === fragKey) return;
    const known = heard[fragKey];
    setTranscriptText(known ?? '');
    setTextOf(known ? { key: fragKey, by: 'auto' } : null);
  }, [fragKey, textOf, heard]);

  const load = async (file: Blob, name: string, kind: RefSource['kind'], script = '') => {
    setError('');
    setBusy(kind === 'mic' ? 'Processing the recording…' : 'Reading the audio…');
    try {
      if (file.size > MAX_FILE) throw new Error('The file is over 600 MB: trim the video or save just the audio');
      let buffer: AudioBuffer;
      try {
        buffer = await decodeAudio(await file.arrayBuffer());
      } catch {
        if (!info?.ffmpeg) throw new Error('The browser could not read audio from this file. Save it as MP4, MP3 or WAV and upload it again.');
        setBusy('Unusual format: extracting the audio on the server…');
        const up = await apiUpload(file, 'source');
        buffer = await decodeUrl((await apiExtract(up.url)).url);
      }
      const mono = toMono(buffer);
      if (peakOf(mono) < 0.002) throw new Error('There is no sound in this file (or it is nearly silent)');
      const first = bestFragment(mono, SAMPLE_RATE);
      const no = ++loads.current;
      setLoadNo(no);
      setSource({ name, kind, buffer, mono, duration: buffer.duration });
      setSel(first);
      setTranscriptText(script);
      setTextOf(script ? { key: fragmentKey(no, name, buffer.duration, first), by: 'script' } : null);
      setSilent([]);
      setHeard({});
      setPrepared(null);
      setOrigin('own');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const snapshot = (): RefHandoff | null => (source ? { source, sel, clean, transcript, textOf, silent, heard, prepared } : null);

  /** Takes over another picker's file and fragment; its keys are re-made for this picker's load number. */
  const adopt = (h: RefHandoff) => {
    const no = ++loads.current;
    const rekey = (k: string) => k.replace(/^\d+\|/, `${no}|`);
    setLoadNo(no);
    setSource(h.source);
    setSel(h.sel);
    setClean(h.clean);
    setTranscriptText(h.transcript);
    setTextOf(h.textOf && { ...h.textOf, key: rekey(h.textOf.key) });
    setSilent(h.silent.map(rekey));
    setHeard(Object.fromEntries(Object.entries(h.heard).map(([k, v]) => [rekey(k), v])));
    setPrepared(h.prepared && { ...h.prepared, key: rekey(h.prepared.key) });
    setOrigin('capture');
    setError('');
  };

  /** Cuts, uploads, optionally cleans the fragment and recognises its words. Reuses the last result while nothing changed. */
  const prepare = async (): Promise<{ sample: PreparedSample; text: string }> => {
    if (!source) throw new Error('Upload an audio or video file with the voice first');
    if (seconds < MIN_SAMPLE_SEC) {
      const e = new Error(`Select at least ${MIN_SAMPLE_SEC} seconds of speech`);
      setError(e.message);
      throw e;
    }
    let text = transcript.trim();
    if (fresh && (text || heardNothing)) return { sample: fresh, text };
    setError('');
    try {
      let sample = fresh;
      if (!sample) {
        setBusy('Cutting the fragment…');
        let voice = cutFragment(source.mono, SAMPLE_RATE, sel.start, sel.end);
        if (clean) {
          // Music hides the pauses, so they are tightened on the isolated voice.
          const raw = (await apiUpload(encodeWav(voice), 'sample')).url;
          setBusy('Removing music and noise…');
          const r = await apiIsolate(raw, seconds);
          addSpent(r.cost);
          voice = toMono(await decodeUrl(r.url));
        }
        const tight = tightenPauses(voice, SAMPLE_RATE);
        const url = (await apiUpload(encodeWav(tight), 'sample')).url;
        sample = { url, seconds: tight.length / SAMPLE_RATE, cleaned: clean, key };
        setPrepared(sample);
      }
      if (!text && !heardNothing) {
        setBusy('Recognising the words…');
        const t = await apiTranscribe(sample.url, sample.seconds, true);
        addSpent(t.cost);
        text = t.text.trim();
        if (text) {
          setTranscriptText(text);
          setTextOf({ key: fragKey, by: 'auto' });
          setHeard((h) => ({ ...h, [fragKey]: text }));
        } else setSilent((s) => [...s, fragKey]);
        // OmniVoice paces new speech by the sample's seconds per word: keep only the audio where Whisper heard the
        // words, or music / noise / a held sound in the fragment would make every generated phrase slow and stretched.
        if (t.segments?.length) {
          const current = toMono(await decodeUrl(sample.url));
          const kept = keepPhrases(current, SAMPLE_RATE, t.segments);
          if (kept.length < current.length - SAMPLE_RATE * 0.4) {
            setBusy('Trimming the sample to the speech…');
            const url = (await apiUpload(encodeWav(kept), 'sample')).url;
            sample = { ...sample, url, seconds: kept.length / SAMPLE_RATE };
            setPrepared(sample);
          }
        }
      }
      return { sample, text };
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy('');
    }
  };

  const reset = () => {
    setSource(null);
    setPrepared(null);
    setTranscriptText('');
    setTextOf(null);
    setSilent([]);
    setHeard({});
    setOrigin('own');
    setError('');
  };

  return {
    source,
    sel,
    setSel,
    clean,
    setClean,
    busy,
    error,
    fresh,
    seconds,
    mock,
    /** Identifies the selected fragment: results made from another fragment are not this one's. */
    fragKey,
    heardNothing,
    tooShort: !!source && seconds < MIN_SAMPLE_SEC,
    /** Paid steps prepare() would run now. */
    prepareCost,
    prepareNote,
    origin,
    load,
    prepare,
    reset,
    snapshot,
    adopt,
  };
}

export type ReferenceState = ReturnType<typeof useReference>;

function quality(seconds: number): { cls: string; text: string } {
  if (seconds < 3) return { cls: 'bad', text: 'too short: at least 3 s' };
  if (seconds < 5) return { cls: 'warn', text: 'a bit short, 6–15 s is best' };
  if (seconds <= 15) return { cls: 'good', text: 'good length' };
  if (seconds <= 20) return { cls: 'warn', text: 'a bit long, 6–15 s is best' };
  return { cls: 'warn', text: 'long sample: no gain in likeness, 6–15 s is best' };
}

/** File / microphone input + waveform + fragment + cleaning / transcript options. */
export function ReferencePicker({ state, intro, active }: { state: ReferenceState; intro: string; active: boolean }) {
  const { source, sel, setSel, busy, error } = state;
  const prices = useVoice((s) => s.prices());
  const [playhead, setPlayhead] = useState<number | null>(null);
  const player = useRef(new RangePlayer());
  const recorder = useRef<MicRecorder | null>(null);
  const [rec, setRec] = useState<{ started: number; level: number; now: number } | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = player.current;
    return () => {
      p.stop();
      recorder.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (active) return;
    player.current.stop(setPlayhead);
    if (recorder.current) {
      recorder.current.cancel();
      recorder.current = null;
      setRec(null);
    }
  }, [active]);

  // Recording meter + auto stop.
  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => {
      const r = recorder.current;
      if (!r) return;
      const now = Date.now();
      setRec((s) => (s ? { ...s, level: r.level(), now } : s));
      if (now - rec.started > MAX_RECORD_SEC * 1000) void stopRecording();
    }, 100);
    return () => window.clearInterval(t);
    // Only restart the timer for a new recording; stopRecording reads refs, not state.
  }, [rec?.started]);

  const onFile = (f: File | undefined) => {
    if (!f) return;
    player.current.stop(setPlayhead);
    const kind = f.type.startsWith('video') || /\.(mp4|mov|m4v|webm|mkv|avi|3gp|wmv|asf|flv|ts|mpe?g)$/i.test(f.name) ? 'video' : 'audio';
    void state.load(f, f.name, kind);
  };

  const startRecording = async () => {
    try {
      player.current.stop(setPlayhead);
      const r = new MicRecorder();
      await r.start();
      recorder.current = r;
      setRec({ started: Date.now(), level: 0, now: Date.now() });
    } catch (e) {
      const denied = (e as Error).name === 'NotAllowedError';
      useVoice.getState().setError(denied ? 'Microphone access is blocked: allow it in the browser address bar' : `Microphone unavailable: ${(e as Error).message}`);
    }
  };

  const stopRecording = async () => {
    const r = recorder.current;
    recorder.current = null;
    setRec(null);
    if (!r) return;
    const blob = await r.stop();
    await state.load(blob, 'Microphone recording', 'mic', MIC_SCRIPT);
  };

  const cancelRecording = () => {
    recorder.current?.cancel();
    recorder.current = null;
    setRec(null);
  };

  const togglePlay = () => {
    if (!source) return;
    if (player.current.playing) player.current.stop(setPlayhead);
    else player.current.play(source.buffer, sel.start, sel.end, setPlayhead);
  };

  const q = quality(state.seconds);

  if (rec) {
    const elapsed = (rec.now - rec.started) / 1000;
    return (
      <div className="vc-rec">
        <div className="vc-rec-head">
          <span className="vc-rec-dot" /> Recording · {formatClock(elapsed).replace(/\.\d$/, '')} / 0:{MAX_RECORD_SEC}
          <span className="vc-rec-meter">
            <span style={{ width: `${Math.round(rec.level * 100)}%` }} />
          </span>
        </div>
        <div className="muted small">Read aloud, calmly and naturally:</div>
        <div className="vc-rec-script">{MIC_SCRIPT}</div>
        <div className="vc-row">
          <button type="button" className="btn primary" onClick={() => void stopRecording()} disabled={elapsed < 2}>
            Done
          </button>
          <button type="button" className="ghost" onClick={cancelRecording}>
            Cancel
          </button>
          <span className="muted small">A quiet room, 15–30 cm from the microphone.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="vc-ref">
      <input
        ref={fileInput}
        type="file"
        hidden
        accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.weba,.flac,.aif,.aiff,.amr,.caf,.wma,.mp4,.m4v,.mov,.webm,.mkv,.avi,.3gp,.wmv,.asf,.flv,.ts,.mpg,.mpeg"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {!source ? (
        <div
          className={`vc-drop ${over ? 'over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => e.key === 'Enter' && fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            onFile(e.dataTransfer.files?.[0]);
          }}
        >
          {busy ? <Spinner /> : <IconUpload width={26} height={26} />}
          <b>{busy || 'Drop a video or audio file here'}</b>
          <span className="muted small">{intro}</span>
          <span className="vc-drop-actions">
            <span className="btn small">Choose file</span>
            <button
              type="button"
              className="btn small"
              onKeyDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void startRecording();
              }}
            >
              <IconMic width={14} height={14} /> Record with microphone
            </button>
          </span>
        </div>
      ) : (
        <>
          <div className="vc-src">
            <span className={`vc-src-kind ${source.kind}`}>{source.kind === 'video' ? 'video' : source.kind === 'mic' ? 'mic' : 'audio'}</span>
            <span className="vc-src-name" title={source.name}>
              {source.name}
            </span>
            <span className="muted small vc-src-dur">{formatSeconds(source.duration)}</span>
            <span className="spacer" />
            <button type="button" className="ghost small" title="Another file" onClick={() => fileInput.current?.click()}>
              <IconUpload width={15} height={15} />
            </button>
            <button type="button" className="ghost small" title="Record with microphone" onClick={() => void startRecording()}>
              <IconMic width={15} height={15} />
            </button>
            <button
              type="button"
              className="ghost small"
              title="Remove"
              onClick={() => {
                player.current.stop(setPlayhead);
                state.reset();
              }}
            >
              <IconClose width={15} height={15} />
            </button>
          </div>
          <Waveform mono={source.mono} sampleRate={SAMPLE_RATE} sel={sel} onSel={setSel} playhead={playhead} />
          <div className="vc-row">
            <button type="button" className="btn small" onClick={togglePlay}>
              {playhead !== null ? <IconPause width={14} height={14} /> : <IconPlay width={14} height={14} />} {playhead !== null ? 'Stop' : 'Play fragment'}
            </button>
            <span className="vc-sel-time">
              {formatClock(sel.start)} – {formatClock(sel.end)} · <b>{state.seconds.toFixed(1)} s</b>
            </span>
            <span className={`vc-quality ${q.cls}`}>{q.text}</span>
            <span className="spacer" />
            <button type="button" className="ghost small" title="Find the best speech fragment again" onClick={() => setSel(bestFragment(source.mono, SAMPLE_RATE))}>
              <IconWand width={15} height={15} /> Auto
            </button>
          </div>
          <div className="muted small">Pick a part where only this person talks: 6–15 seconds of clean speech without interruptions. Drag the edges with the mouse.</div>

          <label className="vc-check" title="Separates the voice from music and background noise (Audio Vocal Isolator)">
            <input type="checkbox" checked={state.clean} onChange={(e) => state.setClean(e.target.checked)} />
            <span>
              Remove background music{' '}
              <span className="muted">
                · {state.mock ? 'mock' : usd(perSecond(state.seconds, prices.isolatePerSecond))} · not needed for a clean recording
              </span>
            </span>
          </label>
          {state.heardNothing && <div className="vc-warn small">No words were recognised in this part: pick a part where the person is talking.</div>}

          {state.fresh && (
            <div className="vc-prepared">
              <PlayButton url={state.fresh.url} size={30} title="Play the prepared sample" />
              <span className="small">
                Sample ready: {state.fresh.seconds.toFixed(1)} s{state.fresh.cleaned ? ', music and noise removed' : ''}
              </span>
            </div>
          )}
          {busy && (
            <div className="vc-busy">
              <Spinner small /> {busy}
            </div>
          )}
        </>
      )}
      {error && <div className="vs-error">{error}</div>}
    </div>
  );
}
