import { useMemo, useState } from 'react';
import { IconArrowDown, IconArrowUp, IconChevron, IconCopy, IconFilm, IconPlus, IconRefresh, IconTrash, IconUpload } from '../../editor/Icons';
import { tokenize } from '../script';
import { takeCost, takeStale, useVideo } from '../store';
import { formatTime, replaceKindOf, sceneStill } from '../timeline';
import type { ReplaceKind, Scene, SceneMode } from '../types';
import { Badge, Segmented, Spinner, UploadButton, money } from '../ui';
import { ScriptEditor } from './ScriptEditor';

function SceneCard({ scene, index, count }: { scene: Scene; index: number; count: number }) {
  const project = useVideo((s) => s.project);
  const allInserts = useVideo((s) => s.project.inserts);
  const inserts = useMemo(() => allInserts.filter((i) => i.sceneId === scene.id), [allInserts, scene.id]);
  const open = useVideo((s) => s.openSceneId === scene.id);
  const setOpenScene = useVideo((s) => s.setOpenScene);
  const select = useVideo((s) => s.select);
  const selected = useVideo((s) => s.selection.type === 'scene' && s.selection.id === scene.id);
  const updateScene = useVideo((s) => s.updateScene);
  const setDialogue = useVideo((s) => s.setDialogue);
  const setSceneMode = useVideo((s) => s.setSceneMode);
  const setReplaceKind = useVideo((s) => s.setReplaceKind);
  const setSpeaker = useVideo((s) => s.setSpeaker);
  const removeScene = useVideo((s) => s.removeScene);
  const moveScene = useVideo((s) => s.moveScene);
  const duplicateScene = useVideo((s) => s.duplicateScene);
  const generateTake = useVideo((s) => s.generateTake);
  const uploadTakeVideo = useVideo((s) => s.uploadTakeVideo);
  const serverInfo = useVideo((s) => s.serverInfo);
  const [tab, setTab] = useState<'text' | 'markup'>('text');
  const [showAction, setShowAction] = useState(!!scene.action);

  const keep = scene.mode === 'keep';
  const kind = replaceKindOf(scene);
  const editable = !!scene.source;
  const words = tokenize(scene.dialogue).length;
  const stale = takeStale(scene, project);
  const cost = takeCost(scene, project);
  const still = sceneStill(project, scene);
  const generating = scene.status === 'generating';
  const character = project.characters.find((c) => c.id === scene.speakerId) ?? project.characters[0];
  const looks = character?.looks.filter((l) => l.image) ?? [];
  const range = scene.source ? `${formatTime(scene.source.start)}–${formatTime(scene.source.end)}` : `${scene.take ? scene.take.duration.toFixed(1) : scene.duration} с`;

  const status = keep ? (
    <Badge kind="info">Оригинал</Badge>
  ) : generating ? (
    <Badge kind="generating">
      <Spinner small /> {scene.progress || 'Генерация…'}
    </Badge>
  ) : scene.status === 'error' ? (
    <Badge kind="error">Ошибка</Badge>
  ) : scene.take ? (
    stale ? (
      <Badge kind="stale">Устарело · {money(cost)}</Badge>
    ) : (
      <Badge kind="ready">{scene.take.source === 'mock' ? 'Mock-дубль' : scene.take.source === 'upload' ? 'Свой клип' : scene.take.source === 'edit' ? 'Заменено в кадре' : 'Дубль готов'}</Badge>
    )
  ) : (
    <Badge kind="stale">{kind === 'edit' ? 'Нужна замена' : 'Нужен дубль'} · {money(cost)}</Badge>
  );

  return (
    <div className={`vs-scene ${open ? 'open' : ''} ${selected ? 'selected' : ''} ${keep ? 'keep' : 'replace'}`}>
      <div
        className="vs-scene-head"
        onClick={() => {
          setOpenScene(open ? null : scene.id);
          select({ type: 'scene', id: scene.id });
        }}
      >
        <span className="vs-scene-num">{index + 1}</span>
        <span className="vs-scene-thumb">{still ? <img src={still} alt="" /> : <IconFilm width={16} height={16} />}</span>
        <div className="vs-scene-title">
          <input className="vs-inline-input" value={scene.name} onClick={(e) => e.stopPropagation()} onChange={(e) => updateScene(scene.id, { name: e.target.value })} />
          <div className="vs-scene-meta muted small">
            {range} · {words} слов{inserts.length ? ` · ${inserts.length} вст.` : ''}
            {character && project.characters.length > 1 ? ` · ${character.name}` : ''}
          </div>
        </div>
        <div className="vs-scene-right" onClick={(e) => e.stopPropagation()}>
          <Segmented<SceneMode>
            small
            value={scene.mode}
            onChange={(m) => {
              setSceneMode(scene.id, m);
              if (m === 'replace') setOpenScene(scene.id);
            }}
            options={[
              { value: 'keep', label: 'Оригинал', title: 'Оставить этот кусок видео как есть' },
              { value: 'replace', label: 'Заменить', title: 'Перегенерировать с новым ведущим (Seedance 2.5)' },
            ]}
          />
          {status}
        </div>
        <IconChevron className="chev" width={16} height={16} />
      </div>

      {open && (
        <div className="vs-scene-body">
          {project.characters.length > 1 && (
            <div className="vs-row">
              <span className="small muted">Кто говорит:</span>
              <select className="vs-select small" value={scene.speakerId ?? project.characters[0]?.id ?? ''} onChange={(e) => setSpeaker(scene.id, e.target.value || null)}>
                {project.characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {!keep && looks.length > 1 && (
                <select className="vs-select small" value={scene.lookId ?? ''} onChange={(e) => updateScene(scene.id, { lookId: e.target.value || null })} title="Образ в этой сцене">
                  <option value="">Образ: основной</option>
                  {looks.map((l) => (
                    <option key={l.id} value={l.id}>
                      Образ: {l.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {!keep && (
            <div className="vs-row">
              <span className="small muted">Как заменяем:</span>
              <Segmented<ReplaceKind>
                small
                value={kind}
                onChange={(k) => setReplaceKind(scene.id, k)}
                options={[
                  { value: 'edit', label: 'В кадре', title: editable ? 'Seedance video-edit: в этом же куске видео меняется только человек, всё остальное остаётся' : 'Нужен фрагмент исходного видео' },
                  { value: 'generate', label: 'Снять заново с фото', title: 'Seedance image-to-video: новый кадр из образа персонажа, говорит текст сцены' },
                ]}
              />
            </div>
          )}
          {!keep && kind === 'edit' && !editable && <div className="vs-error small">У сцены нет фрагмента исходного видео, замена в кадре невозможна: выберите «Снять заново с фото».</div>}
          <div className="vs-tabs">
            <button type="button" className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}>
              {keep || kind === 'edit' ? 'Текст (субтитры)' : 'Новый текст'}
            </button>
            <button type="button" className={tab === 'markup' ? 'on' : ''} onClick={() => setTab('markup')} title="Вставки картинок, произношение, разрывы субтитров">
              Вставки и разметка
            </button>
            <span className="spacer" />
            {!keep && project.characters.length <= 1 && looks.length > 1 && (
              <select className="vs-select small" value={scene.lookId ?? ''} onChange={(e) => updateScene(scene.id, { lookId: e.target.value || null })} title="Образ в этой сцене">
                <option value="">Образ: основной</option>
                {looks.map((l) => (
                  <option key={l.id} value={l.id}>
                    Образ: {l.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {tab === 'text' ? (
            <>
              <textarea
                className="vs-textarea"
                rows={keep ? 3 : 4}
                placeholder={keep ? 'Что говорят в этом куске (для субтитров и вставок)' : 'Что скажет новый ведущий. Одна сцена = один дубль Seedance (4–30 с, ~2–3 слова в секунду).'}
                value={scene.dialogue}
                onChange={(e) => setDialogue(scene.id, e.target.value)}
              />
              {!keep && kind === 'generate' && scene.original && scene.original !== scene.dialogue && (
                <div className="vs-scene-orig small">
                  <span className="muted">В оригинале:</span> {scene.original}{' '}
                  <button type="button" className="vs-linkbtn inline" onClick={() => setDialogue(scene.id, scene.original)}>
                    вернуть
                  </button>
                </div>
              )}
              {keep && <div className="muted small">Правки здесь меняют только субтитры. Чтобы ведущий сказал другое, переключите сцену на «Заменить».</div>}
              {!keep && kind === 'edit' && <div className="muted small">При замене в кадре речь остаётся оригинальной, новый человек повторяет её по губам. Текст здесь только для субтитров и вставок. Чтобы сказать другое, выберите «Снять заново с фото».</div>}
            </>
          ) : (
            <ScriptEditor scene={scene} inserts={inserts} />
          )}

          {!keep && (
            <>
              <button type="button" className="vs-linkbtn" onClick={() => setShowAction((v) => !v)}>
                {showAction ? '▾' : '▸'} Игра и жесты {scene.action ? '' : '(необязательно)'}
              </button>
              {showAction && (
                <textarea
                  className="vs-textarea"
                  rows={3}
                  placeholder="Как ведущий это подаёт: настроение, жесты на ключевых словах. Например: «на слове X приглаживает волосы, в конце саркастично пожимает плечами»."
                  value={scene.action}
                  onChange={(e) => updateScene(scene.id, { action: e.target.value })}
                />
              )}
              {scene.error && <div className="vs-error small">{scene.error}</div>}
              <div className="vs-scene-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={generating || (kind === 'generate' ? !scene.dialogue.trim() : !editable)}
                  onClick={() => void generateTake(scene.id)}
                  title={kind === 'edit' ? `Seedance 2.5 video-edit · ${project.resolution} · оплата за вход и выход` : `Seedance 2.5 · ${project.resolution} · ${scene.duration} с`}
                >
                  {generating ? <Spinner small /> : scene.take && !stale ? <IconRefresh width={16} height={16} /> : <IconFilm width={16} height={16} />}
                  {kind === 'edit' ? (scene.take?.source === 'edit' && !stale ? 'Заменить ещё раз' : 'Заменить человека в кадре') : scene.take && !stale ? 'Перегенерировать' : 'Сгенерировать дубль'} · {money(cost)}
                </button>
                <UploadButton accept="video/*" className="ghost" disabled={generating} onFile={(f) => void uploadTakeVideo(scene.id, f)} title="Использовать свой клип вместо генерации">
                  <IconUpload width={16} height={16} /> Свой клип
                </UploadButton>
              </div>
              {serverInfo?.provider === 'mock' && <div className="muted small">Mock-режим: без ключа WaveSpeed дубль не генерируется, сцена показывает кадр с расчётными таймингами.</div>}
            </>
          )}

          <div className="vs-scene-tools">
            <button type="button" className="ghost small" disabled={index === 0} title="Выше" onClick={() => moveScene(scene.id, -1)}>
              <IconArrowUp width={15} height={15} />
            </button>
            <button type="button" className="ghost small" disabled={index === count - 1} title="Ниже" onClick={() => moveScene(scene.id, 1)}>
              <IconArrowDown width={15} height={15} />
            </button>
            <button type="button" className="ghost small" title="Дублировать сцену" onClick={() => duplicateScene(scene.id)}>
              <IconCopy width={15} height={15} />
            </button>
            <span className="muted small">Разрезать / склеить: в панели справа</span>
            <span className="spacer" />
            <button type="button" className="ghost small danger" disabled={count <= 1} title="Удалить сцену" onClick={() => removeScene(scene.id)}>
              <IconTrash width={15} height={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ScenesPanel() {
  const scenes = useVideo((s) => s.project.scenes);
  const source = useVideo((s) => s.project.source);
  const addScene = useVideo((s) => s.addScene);
  const replaced = scenes.filter((s) => s.mode === 'replace').length;
  return (
    <div className="vs-scenes">
      {scenes.length === 0 && <div className="muted small">Сцены появятся после загрузки видео (шаг 1). Или добавьте сцену вручную, чтобы написать её с нуля.</div>}
      {scenes.length > 0 && (
        <div className="muted small vs-scenes-hint">
          {source ? 'Каждая фраза из видео стала сценой. ' : ''}
          «Оригинал» играет исходный кусок, «Заменить» генерирует новый дубль с вашим ведущим. Сейчас заменено: {replaced} из {scenes.length}.
        </div>
      )}
      {scenes.map((s, i) => (
        <SceneCard key={s.id} scene={s} index={i} count={scenes.length} />
      ))}
      <button type="button" className="ghost wide vs-add" onClick={() => addScene()}>
        <IconPlus width={16} height={16} /> Добавить сцену с нуля
      </button>
    </div>
  );
}
