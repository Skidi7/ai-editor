import { useState } from 'react';
import { IconChevron, IconClose, IconPlus, IconTrash, IconUpload, IconUser } from '../../editor/Icons';
import { useVideo } from '../store';
import type { Character, EditRhythm, Gesture, Performance, TakeMode } from '../types';
import { Field, Segmented, Spinner, UploadButton } from '../ui';

function CharacterCard({ ch, index }: { ch: Character; index: number }) {
  const scenes = useVideo((s) => s.project.scenes);
  const firstId = useVideo((s) => s.project.characters[0]?.id);
  const selection = useVideo((s) => s.selection);
  const select = useVideo((s) => s.select);
  const updateCharacter = useVideo((s) => s.updateCharacter);
  const removeCharacter = useVideo((s) => s.removeCharacter);
  const uploadCharacterPhoto = useVideo((s) => s.uploadCharacterPhoto);
  const uploadVoiceSample = useVideo((s) => s.uploadVoiceSample);
  const clearVoiceSample = useVideo((s) => s.clearVoiceSample);
  const addLook = useVideo((s) => s.addLook);
  const setActiveLook = useVideo((s) => s.setActiveLook);
  const setCharacterScenes = useVideo((s) => s.setCharacterScenes);
  const [open, setOpen] = useState(index === 0);
  const [voiceOpen, setVoiceOpen] = useState(false);

  const mine = scenes.filter((s) => (s.speakerId ?? firstId) === ch.id);
  const replaced = mine.filter((s) => s.mode === 'replace').length;
  const patch = (p: Partial<Character>) => updateCharacter(ch.id, p);
  const avatar = ch.looks.find((l) => l.id === ch.activeLookId)?.image || ch.reference;

  return (
    <div className={`vs-char ${open ? 'open' : ''}`}>
      <div className="vs-char-head" onClick={() => setOpen((o) => !o)}>
        <span className="vs-char-avatar">{avatar ? <img src={avatar} alt="" /> : <IconUser width={18} height={18} />}</span>
        <input className="vs-inline-input" value={ch.name} onClick={(e) => e.stopPropagation()} onChange={(e) => patch({ name: e.target.value })} />
        <span className="muted small vs-char-sum">
          {mine.length ? `${mine.length} сцен · заменить ${replaced}` : 'нет сцен'}
          {!ch.reference && ' · нет фото'}
        </span>
        <IconChevron className="chev" width={16} height={16} />
      </div>
      {open && (
        <div className="vs-char-body">
          {!ch.reference ? (
            <UploadButton accept="image/*" className="vs-dropzone" onFile={(f) => void uploadCharacterPhoto(ch.id, f)}>
              <IconUpload width={22} height={22} />
              <b>Фото нового ведущего</b>
              <span className="muted small">Это лицо будет говорить вместо оригинала в сценах, отмеченных «Заменить». Портрет или полуростовое фото.</span>
            </UploadButton>
          ) : (
            <>
              <div className="vs-looks">
                {ch.looks.map((l) => {
                  const active = ch.activeLookId === l.id;
                  const selected = selection.type === 'look' && selection.id === l.id;
                  return (
                    <button
                      key={l.id}
                      type="button"
                      className={`vs-look ${active ? 'active' : ''} ${selected ? 'selected' : ''}`}
                      onClick={() => {
                        if (l.source === 'generated') select({ type: 'look', characterId: ch.id, id: l.id });
                        if (l.image) setActiveLook(ch.id, l.id);
                      }}
                      title={l.source === 'photo' ? 'Исходное фото' : 'Открыть настройки образа'}
                    >
                      <span className="vs-look-thumb">
                        {l.image ? <img src={l.image} alt="" /> : <IconUser width={22} height={22} />}
                        {l.status === 'generating' && (
                          <span className="vs-look-busy">
                            <Spinner />
                          </span>
                        )}
                      </span>
                      <span className="vs-look-name">{l.name}</span>
                      {active && <span className="vs-look-active">основной</span>}
                    </button>
                  );
                })}
                <button type="button" className="vs-look add" onClick={() => addLook(ch.id)} title="Другая одежда, поза или место: Seedream 5 Pro, 2K, $0.09">
                  <span className="vs-look-thumb">
                    <IconPlus width={22} height={22} />
                  </span>
                  <span className="vs-look-name">Новый образ</span>
                </button>
              </div>
              <div className="vs-row">
                <UploadButton accept="image/*" className="ghost small" onFile={(f) => void uploadCharacterPhoto(ch.id, f)}>
                  <IconUpload width={14} height={14} /> Заменить фото
                </UploadButton>
                <span className="muted small">Образ «основной» — первый кадр каждой заменённой сцены.</span>
              </div>
            </>
          )}

          {mine.length > 0 && (
            <div className="vs-row">
              <button type="button" className="btn small" disabled={replaced === mine.length} onClick={() => setCharacterScenes(ch.id, 'replace')} title="Все сцены этого персонажа будут перегенерированы с новым лицом">
                Заменить во всех {mine.length} сценах
              </button>
              <button type="button" className="ghost small" disabled={replaced === 0} onClick={() => setCharacterScenes(ch.id, 'keep')}>
                Вернуть оригинал
              </button>
            </div>
          )}

          <button type="button" className="vs-linkbtn" onClick={() => setVoiceOpen((v) => !v)}>
            {voiceOpen ? '▾' : '▸'} Голос и подача
          </button>
          {voiceOpen && (
            <>
              <Field label="Голос словами" hint="попадёт в промпт Seedance">
                <textarea
                  className="vs-textarea"
                  rows={2}
                  placeholder="Например: низкий хрипловатый голос, сухая саркастичная подача, чёткий комедийный тайминг"
                  value={ch.voice}
                  onChange={(e) => patch({ voice: e.target.value })}
                />
              </Field>
              <div className="vs-grid2">
                <Field label="Энергия">
                  <select className="vs-select" value={ch.performance} onChange={(e) => patch({ performance: e.target.value as Performance })}>
                    <option value="natural-explainer">Спокойно объясняет</option>
                    <option value="high-energy-ugc">Энергичный UGC</option>
                    <option value="calm-authority">Спокойная уверенность</option>
                    <option value="reactive-playful">Живо, игриво</option>
                  </select>
                </Field>
                <Field label="Жесты">
                  <select className="vs-select" value={ch.gesture} onChange={(e) => patch({ gesture: e.target.value as Gesture })}>
                    <option value="restrained">Почти без рук</option>
                    <option value="compact">Компактные</option>
                    <option value="natural">Естественные</option>
                    <option value="expressive">Выразительные</option>
                  </select>
                </Field>
                <Field label="Монтаж">
                  <select className="vs-select" value={ch.editRhythm} onChange={(e) => patch({ editRhythm: e.target.value as EditRhythm })}>
                    <option value="continuous-take">Один непрерывный дубль</option>
                    <option value="pause-trim-jump-cuts">Джамп-каты на паузах</option>
                  </select>
                </Field>
                <Field label="Как использовать фото">
                  <Segmented<TakeMode>
                    small
                    value={ch.mode}
                    onChange={(mode) => patch({ mode })}
                    options={[
                      { value: 'image', label: 'Первый кадр', title: 'Image-to-video: видео начинается точно с образа' },
                      { value: 'reference', label: '+ голос', title: 'Reference-to-video: фото и аудио-образец как референсы' },
                    ]}
                  />
                </Field>
              </div>
              {ch.mode === 'reference' && (
                <div className="vs-row">
                  {ch.voiceSample ? (
                    <>
                      <audio controls src={ch.voiceSample} className="vs-audio" />
                      <button type="button" className="ghost small" title="Убрать образец" onClick={() => clearVoiceSample(ch.id)}>
                        <IconClose width={14} height={14} />
                      </button>
                    </>
                  ) : (
                    <UploadButton accept="audio/*" className="ghost small" onFile={(f) => void uploadVoiceSample(ch.id, f)}>
                      <IconUpload width={14} height={14} /> Образец голоса (до 30 с)
                    </UploadButton>
                  )}
                </div>
              )}
            </>
          )}

          <div className="vs-row">
            <span className="spacer" />
            <button type="button" className="ghost small danger" onClick={() => removeCharacter(ch.id)} title="Удалить персонажа">
              <IconTrash width={14} height={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Step 2: who speaks. One character by default; add more when several people talk in the source video. */
export function CharactersPanel() {
  const characters = useVideo((s) => s.project.characters);
  const addCharacter = useVideo((s) => s.addCharacter);
  return (
    <div className="vs-chars">
      {characters.length === 0 && <div className="muted small">Персонаж появится автоматически после разбора видео. Фото нужно только для сцен, которые вы решите заменить.</div>}
      {characters.map((c, i) => (
        <CharacterCard key={c.id} ch={c} index={i} />
      ))}
      <button type="button" className="ghost wide vs-add" onClick={() => addCharacter()}>
        <IconPlus width={16} height={16} /> Ещё персонаж (если в видео говорят несколько людей)
      </button>
    </div>
  );
}
