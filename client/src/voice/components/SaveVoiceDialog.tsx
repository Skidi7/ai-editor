import { useEffect, useState } from 'react';
import { IconClose } from '../../editor/Icons';
import { Segmented } from '../../video/ui';
import { useVoice } from '../store';
import { AGE_GROUPS, type AgeGroup, type Gender, type Voice, type VoiceSource } from '../types';
import { PlayButton, Tags } from './common';

export interface SaveInitial {
  name: string;
  gender: Gender | null;
  age: AgeGroup | null;
  timbre: string[];
  manner: string[];
  description: string;
  sample: string;
  sampleText: string;
  source: VoiceSource;
}

/** «Save to my voices»: a name is required, the rest helps to find the voice later. Tags come from the AI, if any. */
export function SaveVoiceDialog({ initial, onClose, onSaved }: { initial: SaveInitial; onClose: () => void; onSaved?: (v: Voice) => void }) {
  const saveVoice = useVoice((s) => s.saveVoice);
  const [name, setName] = useState(initial.name);
  const [gender, setGender] = useState<Gender | ''>(initial.gender ?? '');
  const [age, setAge] = useState<AgeGroup | ''>(initial.age ?? '');
  const timbre = initial.timbre.slice(0, 3);
  const manner = initial.manner.slice(0, 3);
  const [description, setDescription] = useState(initial.description);
  const [saving, setSaving] = useState(false);

  // Escape closes the dialog wherever the focus is (the page behind it included).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const voice = await saveVoice({
      name: name.trim(),
      sample: initial.sample,
      sampleText: initial.sampleText,
      gender: gender || null,
      age: age || null,
      timbre,
      manner,
      description,
      source: initial.source,
    });
    setSaving(false);
    if (voice) {
      onSaved?.(voice);
      onClose();
    }
  };

  return (
    // A click outside closes only an untouched dialog, so a typed name is not lost by a stray click; Escape always closes.
    <div className="vs-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && name === initial.name && onClose()}>
      <div className="vs-modal vc-save">
        <div className="vs-insp-head">
          <span className="vs-insp-title">Save to my voices</span>
          <span className="spacer" />
          <button type="button" className="ghost small" onClick={onClose} title="Close">
            <IconClose width={16} height={16} />
          </button>
        </div>
        <div className="vs-insp-body">
          <div className="vc-prepared">
            <PlayButton url={initial.sample} size={32} title="Play the sample" />
            <span className="small muted vc-save-text">{initial.sampleText ? `“${initial.sampleText}”` : 'The words of the sample are unknown: the voice is saved anyway'}</span>
          </div>
          <div className="vs-field">
            <span className="vs-field-label">Name</span>
            <input
              className="vs-input"
              autoFocus
              value={name}
              maxLength={60}
              placeholder="For example: Night radio host"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </div>
          <div className="vs-grid2">
            <div className="vs-field">
              <span className="vs-field-label">Gender</span>
              <Segmented<Gender | ''>
                small
                value={gender}
                onChange={setGender}
                options={[
                  { value: '', label: '—' },
                  { value: 'female', label: 'Female' },
                  { value: 'male', label: 'Male' },
                ]}
              />
            </div>
            <div className="vs-field">
              <span className="vs-field-label">Age</span>
              <select className="vs-select" value={age} onChange={(e) => setAge(e.target.value as AgeGroup | '')}>
                <option value="">not set</option>
                {AGE_GROUPS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {timbre.length + manner.length > 0 && (
            <div className="vs-field">
              <span className="vs-field-label">
                Tags <span className="vs-field-hint">for search in the library</span>
              </span>
              <Tags items={[...timbre, ...manner]} />
            </div>
          )}
          <div className="vs-field">
            <span className="vs-field-label">
              Note <span className="vs-field-hint">optional</span>
            </span>
            <textarea className="vs-textarea" rows={2} value={description} placeholder="What the voice is for, where it comes from" onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="vc-row">
            <span className="spacer" />
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={!name.trim() || saving} onClick={() => void submit()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
