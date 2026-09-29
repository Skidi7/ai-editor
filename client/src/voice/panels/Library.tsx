import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconEdit, IconRefresh, IconTrash } from '../../editor/Icons';
import { Segmented, Spinner } from '../../video/ui';
import { PlayButton, VoiceAvatar } from '../components/common';
import { useVoice, type LibraryFilter } from '../store';
import { qwenPrice } from '../text';
import { AGE_GROUPS, ageLabel, usd, type Voice } from '../types';

function matches(v: Voice, f: LibraryFilter): boolean {
  if (f.gender !== 'all' && v.gender !== f.gender) return false;
  if (f.age !== 'all' && v.age !== f.age) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  return [v.name, ...v.timbre, ...v.manner, v.useCase ?? '', v.description].some((s) => s.toLowerCase().includes(q));
}

/** Off until the library has rendered once, so opening the page does not jump into the middle of the list. */
let scrollOnSelect = false;

const SOURCE_LABEL: Record<Voice['source'], string> = {
  design: 'created from a description',
  capture: 'captured from a file',
  clone: 'cloned',
  mic: 'recorded with a microphone',
  preset: '',
};

function VoiceCard({ v }: { v: Voice }) {
  const selected = useVoice((s) => s.selectedId === v.id);
  const select = useVoice((s) => s.select);
  const updateVoice = useVoice((s) => s.updateVoice);
  const deleteVoice = useVoice((s) => s.deleteVoice);
  const preparePresets = useVoice((s) => s.preparePresets);
  // No regenerating while anything is being made: a long text spoken in this voice would switch voice mid-way.
  const busy = useVoice((s) => !!s.preparing || !!s.speaking);
  const editable = useVoice((s) => s.info?.presetsEditable !== false);
  const mock = useVoice((s) => s.info?.provider === 'mock');
  const prices = useVoice((s) => s.prices());
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(v.name);
  const ref = useRef<HTMLDivElement>(null);

  // A voice selected from elsewhere (just saved, picked in history) scrolls into view; the first load keeps the list at the top.
  useEffect(() => {
    if (selected && scrollOnSelect) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const commit = async () => {
    const n = name.trim();
    setEditing(false);
    if (n && n !== v.name) {
      if (!(await updateVoice(v.id, { name: n }))) setName(v.name);
    } else setName(v.name);
  };

  const tags = [...v.timbre, ...v.manner];
  const sub = [ageLabel(v), v.gender === 'female' ? 'female' : v.gender === 'male' ? 'male' : ''].filter(Boolean).join(' · ');

  return (
    <div
      ref={ref}
      className={`vc-voice ${selected ? 'on' : ''} ${v.sample ? '' : 'empty'}`}
      role="button"
      tabIndex={0}
      onClick={() => !editing && select(v.id)}
      onKeyDown={(e) => {
        if (editing || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        select(v.id);
      }}
    >
      <VoiceAvatar name={v.name} gender={v.gender} size={40} />
      <div className="vc-voice-main">
        {editing ? (
          <input
            className="vs-input vc-rename"
            autoFocus
            value={name}
            maxLength={60}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
              if (e.key === 'Escape') {
                setName(v.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <div className="vc-voice-name">
            <b>{v.name}</b>
            {sub && <span className="muted small">{sub}</span>}
          </div>
        )}
        {tags.length > 0 && <div className="vc-voice-tags">{tags.slice(0, 4).join(' · ')}</div>}
        {v.kind === 'preset' ? (
          v.useCase && <div className="vc-voice-use">{v.sample ? v.useCase : editable ? 'sample is made on first use' : 'not available yet'}</div>
        ) : (
          <div className="vc-voice-use">{SOURCE_LABEL[v.source]}</div>
        )}
      </div>
      {v.kind === 'preset' && v.sample && editable && (
        <span className="vc-voice-tools">
          <button
            type="button"
            className="ghost small"
            title="Regenerate the sample: the voice will come out different"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              const cost = mock ? 'mock, free' : usd(qwenPrice(v.recipeChars ?? v.sampleText.length, prices));
              if (window.confirm(`Regenerate the sample for ${v.name}?\nYou get a different voice from the same description; the old sample is replaced. ${cost}.`)) {
                void preparePresets([v.id], true);
              }
            }}
          >
            <IconRefresh width={14} height={14} />
          </button>
        </span>
      )}
      {v.kind === 'custom' && !editing && (
        <span className="vc-voice-tools">
          <button
            type="button"
            className="ghost small"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <IconEdit width={14} height={14} />
          </button>
          <button
            type="button"
            className="ghost small danger"
            title="Delete from the library"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Delete ${v.name} from the library?`)) void deleteVoice(v.id);
            }}
          >
            <IconTrash width={14} height={14} />
          </button>
        </span>
      )}
      {selected && !editing && (
        <span className="vc-voice-check">
          <IconCheck width={12} height={12} />
        </span>
      )}
      <PlayButton url={v.sample} size={32} disabledTitle="No sample yet" />
    </div>
  );
}

/** Left column: built-in voices + the user's voices, with search and filters. */
export function Library() {
  const presets = useVoice((s) => s.presets);
  const mine = useVoice((s) => s.mine);
  const loaded = useVoice((s) => s.loaded);
  const filter = useVoice((s) => s.filter);
  const setFilter = useVoice((s) => s.setFilter);
  const preparing = useVoice((s) => s.preparing);
  const preparePresets = useVoice((s) => s.preparePresets);
  const editable = useVoice((s) => s.info?.presetsEditable !== false);
  const mock = useVoice((s) => s.info?.provider === 'mock');
  const prices = useVoice((s) => s.prices());

  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => (scrollOnSelect = true), 300);
    return () => window.clearTimeout(t);
  }, [loaded]);

  const minePicked = mine.filter((v) => matches(v, filter));
  const presetsPicked = presets.filter((v) => matches(v, filter));
  const missing = presets.filter((p) => !p.sample);
  const missingCost = missing.reduce((sum, p) => sum + qwenPrice(p.recipeChars ?? p.sampleText.length, prices), 0);

  const prepareAll = () => {
    const msg = mock
      ? `Create mock samples for ${missing.length} voices? (free, synthetic sound instead of a voice)`
      : `Create samples for ${missing.length} library voices?\nQwen3 Voice Design, one phrase per voice, ≈ ${usd(missingCost)}.\nThis is done once.`;
    if (window.confirm(msg)) void preparePresets(null);
  };

  return (
    <div className="vc-lib">
      <div className="vc-lib-head">
        <span className="vc-col-title">Voice library</span>
        <span className="vc-count">{presets.length + mine.length}</span>
      </div>
      <input className="vs-input" placeholder="Search: name, timbre, manner, use…" value={filter.query} onChange={(e) => setFilter({ query: e.target.value })} />
      <Segmented<LibraryFilter['scope']>
        small
        value={filter.scope}
        onChange={(scope) => setFilter({ scope })}
        options={[
          { value: 'all', label: 'All' },
          { value: 'presets', label: `Library · ${presets.length}` },
          { value: 'mine', label: `Mine · ${mine.length}` },
        ]}
      />
      <div className="vc-row">
        <Segmented<LibraryFilter['gender']>
          small
          value={filter.gender}
          onChange={(gender) => setFilter({ gender })}
          options={[
            { value: 'all', label: 'Any gender' },
            { value: 'female', label: 'Female' },
            { value: 'male', label: 'Male' },
          ]}
        />
        <select className="vs-select small" value={filter.age} onChange={(e) => setFilter({ age: e.target.value as LibraryFilter['age'] })}>
          <option value="all">Any age</option>
          {AGE_GROUPS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      {preparing ? (
        <div className="vc-banner">
          <span className="vc-row">
            <Spinner small /> <b>Creating voice samples</b>
          </span>
          <span className="muted small">{preparing.message}</span>
        </div>
      ) : (
        loaded &&
        editable &&
        missing.length > 0 &&
        filter.scope !== 'mine' && (
          <div className="vc-banner">
            <b>
              Library samples: {presets.length - missing.length} of {presets.length}
            </b>
            <span className="muted small">
              Each library voice is a short phrase created once (Qwen3 Voice Design). After that every text is voiced in exactly that voice. No need to wait: a
              sample is also made on the first use of a voice.
            </span>
            <button type="button" className="btn small primary" onClick={prepareAll}>
              Create all · {mock ? 'mock' : usd(missingCost)}
            </button>
          </div>
        )
      )}

      <div className="vc-lib-list">
        {filter.scope !== 'presets' && (
          <>
            <div className="vc-group-title">My voices</div>
            {minePicked.map((v) => (
              <VoiceCard key={v.id} v={v} />
            ))}
            {!minePicked.length && (
              <div className="vc-empty small">{mine.length ? 'Nothing found.' : 'Empty for now. Create a voice from a description, capture one from a video or clone your own — it shows up here.'}</div>
            )}
          </>
        )}
        {filter.scope !== 'mine' && (
          <>
            <div className="vc-group-title">Library</div>
            {presetsPicked.map((v) => (
              <VoiceCard key={v.id} v={v} />
            ))}
            {!presetsPicked.length && <div className="vc-empty small">{loaded ? 'Nothing found.' : 'Loading…'}</div>}
          </>
        )}
      </div>
    </div>
  );
}
