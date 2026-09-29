import { IconBreak, IconClose, IconImage, IconRefresh, IconTrash, IconUpload, IconWand } from '../../editor/Icons';
import { Slider } from '../../editor/ui';
import { insertPlacement } from '../compositor';
import { insertColor, tokenize } from '../script';
import { pendingCost, takeCost, useVideo } from '../store';
import { formatTime } from '../timeline';
import { IMAGE_PRICE, type Insert, type InsertAspect, type InsertFrame, type InsertMotion, type Look, type Scene } from '../types';
import { Badge, Field, Segmented, Spinner, UploadButton, money } from '../ui';

function Head({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="vs-insp-head">
      <span className="vs-insp-title">{title}</span>
      <span className="spacer" />
      <button type="button" className="ghost small" onClick={onClose} title="Закрыть">
        <IconClose width={16} height={16} />
      </button>
    </div>
  );
}

function FramePicker({ value, aspect, custom, onChange }: { value: InsertFrame; aspect: string; custom: boolean; onChange: (f: InsertFrame) => void }) {
  const frames: { id: InsertFrame; label: string; w: number }[] = [
    { id: 'left', label: 'Слева внизу', w: 0.58 },
    { id: 'right', label: 'Справа внизу', w: 0.42 },
    { id: 'wide', label: 'Во всю ширину', w: 0.94 },
    { id: 'top', label: 'Сверху', w: 0.7 },
    { id: 'center', label: 'По центру', w: 0.7 },
  ];
  const portrait = aspect === '9:16';
  return (
    <div className="vs-frames">
      {frames.map((f) => {
        const { cx, cy } = insertPlacement(f.id, aspect);
        const h = f.w * (portrait ? 0.4 : 0.9);
        return (
          <button key={f.id} type="button" className={`vs-frame ${!custom && value === f.id ? 'on' : ''}`} title={f.label} onClick={() => onChange(f.id)}>
            <span className={`vs-frame-phone ${portrait ? 'portrait' : aspect === '1:1' ? 'square' : 'wide'}`}>
              <span className="vs-frame-card" style={{ left: `${(cx - f.w / 2) * 100}%`, top: `${(cy - h / 2) * 100}%`, width: `${f.w * 100}%`, height: `${h * 100}%` }} />
            </span>
            <span className="small">{f.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function InsertInspector({ insert }: { insert: Insert }) {
  const project = useVideo((s) => s.project);
  const updateInsert = useVideo((s) => s.updateInsert);
  const removeInsert = useVideo((s) => s.removeInsert);
  const generateInsertImage = useVideo((s) => s.generateInsertImage);
  const uploadInsertImage = useVideo((s) => s.uploadInsertImage);
  const select = useVideo((s) => s.select);
  const scene = project.scenes.find((s) => s.id === insert.sceneId);
  const tokens = scene ? tokenize(scene.dialogue) : [];
  const color = insertColor(project.inserts.indexOf(insert));
  const generating = insert.status === 'generating';
  const custom = insert.x !== undefined && insert.y !== undefined;
  return (
    <>
      <Head title="Вставка (картинка поверх видео)" onClose={() => select({ type: 'none' })} />
      <div className="vs-insp-body">
        <div className="vs-ins-words" style={{ borderColor: color }}>
          <span className="muted small">Появляется на словах</span>
          <b>«{tokens.slice(insert.startWord, insert.endWord + 1).join(' ')}»</b>
          <span className="muted small">сцена «{scene?.name}». Чтобы привязать к другим словам: выделите их во «Вставки и разметка» и создайте вставку заново.</span>
        </div>
        <Field label="Название">
          <input className="vs-input" value={insert.name} onChange={(e) => updateInsert(insert.id, { name: e.target.value })} />
        </Field>

        <div className={`vs-ins-preview ${insert.image ? '' : 'empty'}`} style={{ aspectRatio: insert.aspect.replace(':', '/') }}>
          {insert.image ? <img src={insert.image} alt="" /> : <IconImage width={28} height={28} />}
          {generating && (
            <span className="vs-look-busy">
              <Spinner />
            </span>
          )}
        </div>
        {insert.error && <div className="vs-error small">{insert.error}</div>}

        <Field label="Что на картинке" hint="Seedream 5 Pro, 2K">
          <textarea
            className="vs-textarea"
            rows={4}
            placeholder="Опишите картинку-шутку или иллюстрацию: что, в каком стиле, освещение. Лучше без текста и логотипов."
            value={insert.prompt}
            onChange={(e) => updateInsert(insert.id, { prompt: e.target.value })}
          />
        </Field>
        <div className="vs-grid2">
          <Field label="Пропорции">
            <select className="vs-select" value={insert.aspect} onChange={(e) => updateInsert(insert.id, { aspect: e.target.value as InsertAspect })}>
              <option value="1:1">1:1</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
              <option value="16:9">16:9</option>
              <option value="21:9">21:9</option>
            </select>
          </Field>
          <Field label="Появление">
            <select className="vs-select" value={insert.motion} onChange={(e) => updateInsert(insert.id, { motion: e.target.value as InsertMotion })}>
              <option value="pop">Pop</option>
              <option value="bounce">Bounce</option>
              <option value="scale">Плавно</option>
              <option value="fade">Fade</option>
            </select>
          </Field>
        </div>
        <div className="vs-row">
          <button type="button" className="btn primary" disabled={generating || !insert.prompt.trim()} onClick={() => void generateInsertImage(insert.id)}>
            {generating ? <Spinner small /> : <IconWand width={16} height={16} />} {insert.image ? 'Перегенерировать' : 'Сгенерировать'} · {money(IMAGE_PRICE)}
          </button>
          <UploadButton accept="image/*" className="ghost" disabled={generating} onFile={(f) => void uploadInsertImage(insert.id, f)} title="Своя картинка">
            <IconUpload width={16} height={16} /> Своя
          </UploadButton>
        </div>

        <Field label="Где в кадре" hint="или перетащите прямо на превью">
          <FramePicker value={insert.frame} aspect={project.aspect} custom={custom} onChange={(frame) => updateInsert(insert.id, { frame, x: undefined, y: undefined })} />
        </Field>
        {custom && <div className="muted small">Положение задано вручную на превью. Нажмите на пресет, чтобы вернуть.</div>}
        <Slider label="Ширина" value={insert.width} min={15} max={100} format={(v) => `${v}%`} onChange={(v) => updateInsert(insert.id, { width: v })} />
        <Slider label="Задержка после слов" value={Math.round(insert.hold * 10)} min={0} max={20} format={(v) => `${(v / 10).toFixed(1)} с`} onChange={(v) => updateInsert(insert.id, { hold: v / 10 })} />

        <button type="button" className="ghost danger wide" onClick={() => removeInsert(insert.id)}>
          <IconTrash width={15} height={15} /> Удалить вставку
        </button>
      </div>
    </>
  );
}

function LookInspector({ characterId, look }: { characterId: string; look: Look }) {
  const project = useVideo((s) => s.project);
  const updateLook = useVideo((s) => s.updateLook);
  const generateLook = useVideo((s) => s.generateLook);
  const removeLook = useVideo((s) => s.removeLook);
  const setActiveLook = useVideo((s) => s.setActiveLook);
  const select = useVideo((s) => s.select);
  const ch = project.characters.find((c) => c.id === characterId);
  const generating = look.status === 'generating';
  return (
    <>
      <Head title={`Образ: ${ch?.name ?? ''}`} onClose={() => select({ type: 'none' })} />
      <div className="vs-insp-body">
        <div className="muted small">Seedream 5 Pro в 2K возьмёт лицо с фото и перерисует одежду, позу или место. Заполните только то, что нужно изменить.</div>
        <Field label="Название">
          <input className="vs-input" value={look.name} onChange={(e) => updateLook(characterId, look.id, { name: e.target.value })} />
        </Field>
        <div className={`vs-ins-preview ${look.image ? '' : 'empty'}`} style={{ aspectRatio: project.aspect.replace(':', '/') }}>
          {look.image ? <img src={look.image} alt="" /> : <IconImage width={28} height={28} />}
          {generating && (
            <span className="vs-look-busy">
              <Spinner />
            </span>
          )}
        </div>
        {look.error && <div className="vs-error small">{look.error}</div>}
        <Field label="Одежда">
          <input className="vs-input" placeholder="например: чёрная футболка, чокер, кепка с шипами" value={look.outfit} onChange={(e) => updateLook(characterId, look.id, { outfit: e.target.value })} />
        </Field>
        <Field label="Поза и кадр">
          <input className="vs-input" placeholder="например: сидит справа, в руке микрофон, смотрит в камеру" value={look.pose} onChange={(e) => updateLook(characterId, look.id, { pose: e.target.value })} />
        </Field>
        <Field label="Место">
          <input className="vs-input" placeholder="например: университетская аудитория, постеры на стене" value={look.setting} onChange={(e) => updateLook(characterId, look.id, { setting: e.target.value })} />
        </Field>
        <div className="vs-row">
          <button type="button" className="btn primary" disabled={generating || !ch?.reference} onClick={() => void generateLook(characterId, look.id)}>
            {generating ? <Spinner small /> : <IconWand width={16} height={16} />} {look.image ? 'Перегенерировать' : 'Создать образ'} · {money(IMAGE_PRICE)}
          </button>
          {look.image && ch?.activeLookId !== look.id && (
            <button type="button" className="ghost" onClick={() => setActiveLook(characterId, look.id)}>
              Сделать основным
            </button>
          )}
        </div>
        <button type="button" className="ghost danger wide" onClick={() => removeLook(characterId, look.id)}>
          <IconTrash width={15} height={15} /> Удалить образ
        </button>
      </div>
    </>
  );
}

function SceneInspector({ scene }: { scene: Scene }) {
  const project = useVideo((s) => s.project);
  const tl = useVideo((s) => s.tl);
  const playhead = useVideo((s) => s.playhead);
  const updateScene = useVideo((s) => s.updateScene);
  const setSceneMode = useVideo((s) => s.setSceneMode);
  const splitSceneAt = useVideo((s) => s.splitSceneAt);
  const mergeWithNext = useVideo((s) => s.mergeWithNext);
  const clearTake = useVideo((s) => s.clearTake);
  const alignTake = useVideo((s) => s.alignTake);
  const select = useVideo((s) => s.select);
  const serverInfo = useVideo((s) => s.serverInfo);
  const clip = tl.clips.find((c) => c.scene.id === scene.id);
  const idx = project.scenes.findIndex((s) => s.id === scene.id);
  const next = project.scenes[idx + 1];
  const take = scene.take;
  const keep = scene.mode === 'keep';
  const inside = clip ? playhead > clip.start + 0.3 && playhead < clip.end - 0.3 : false;
  const local = clip ? playhead - clip.start : 0;
  return (
    <>
      <Head title={`Сцена ${idx + 1}: ${scene.name}`} onClose={() => select({ type: 'none' })} />
      <div className="vs-insp-body">
        <Field label="Что делаем с этой сценой">
          <Segmented
            value={scene.mode}
            onChange={(m) => setSceneMode(scene.id, m)}
            options={[
              { value: 'keep', label: 'Оставить оригинал' },
              { value: 'replace', label: 'Заменить ведущего' },
            ]}
          />
          <div className="muted small">
            {keep
              ? 'Играет исходный кусок видео. Субтитры и вставки можно добавить и здесь.'
              : scene.replaceKind === 'generate' || !scene.source
                ? 'Новый кадр с нуля: персонаж из своего образа скажет текст сцены (Seedance image-to-video). Голос и манера из карточки персонажа.'
                : 'В этом куске видео меняется только человек: лицо, волосы, тело. Движения, речь, фон, флаги и надписи остаются (Seedance video-edit). Пока замена не сделана, играет оригинал с пометкой.'}
          </div>
        </Field>
        {clip && (
          <div className="muted small">
            На таймлайне: {formatTime(clip.start)} – {formatTime(clip.end)}
            {scene.source ? ` · в исходнике ${formatTime(scene.source.start)} – ${formatTime(scene.source.end)}` : ''}
          </div>
        )}

        <Field label="Разрезать / склеить" hint="границы сцен">
          <div className="vs-row">
            <button type="button" className="ghost small" disabled={!inside} onClick={() => void splitSceneAt(scene.id, local)} title="Поставьте курсор превью внутри сцены">
              <IconBreak width={14} height={14} /> Разрезать на {inside ? formatTime(playhead) : 'курсоре'}
            </button>
            <button type="button" className="ghost small" disabled={!next} onClick={() => mergeWithNext(scene.id)} title="Объединить со следующей сценой">
              Склеить со следующей
            </button>
          </div>
        </Field>

        {!keep && (
          <>
            {take?.video ? (
              <video className="vs-take-video" controls src={take.video} />
            ) : take ? (
              <div className="muted small">Mock-дубль: вместо видео показывается кадр персонажа.</div>
            ) : (
              <div className="muted small">Дубль ещё не сгенерирован: превью показывает кадр персонажа с расчётными таймингами слов.</div>
            )}
            {take && (
              <div className="vs-row">
                <Badge kind={take.aligned === 'estimate' ? 'info' : 'ready'}>
                  {take.aligned === 'whisper' ? 'Тайминги: Whisper, по словам' : take.aligned === 'whisper-segments' ? 'Тайминги: Whisper, по фразам' : 'Тайминги слов: оценка'}
                </Badge>
                {take.video && serverInfo?.whisper && (
                  <button type="button" className="ghost small" onClick={() => void alignTake(scene.id)} title="Распознать речь и привязать вставки к реальным словам">
                    <IconRefresh width={14} height={14} /> Уточнить
                  </button>
                )}
              </div>
            )}
            <Field label="Длительность дубля" hint={take ? 'из видео' : `запрос к Seedance · ${money(takeCost(scene, project))}`}>
              <Slider label="" value={scene.duration} min={4} max={30} format={(v) => `${v} с`} onChange={(v) => updateScene(scene.id, { duration: v, autoDuration: false })} />
              <label className="vs-check small">
                <input type="checkbox" checked={scene.autoDuration} onChange={(e) => updateScene(scene.id, { autoDuration: e.target.checked })} /> Подбирать по числу слов (~2,4 слова/с)
              </label>
            </Field>
            {take && (
              <button type="button" className="ghost danger wide" onClick={() => clearTake(scene.id)}>
                <IconTrash width={15} height={15} /> Убрать дубль
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Overview() {
  const project = useVideo((s) => s.project);
  const tl = useVideo((s) => s.tl);
  const serverInfo = useVideo((s) => s.serverInfo);
  const replaced = project.scenes.filter((s) => s.mode === 'replace');
  const ready = replaced.filter((s) => s.take).length;
  const images = project.inserts.filter((i) => i.image).length;
  return (
    <>
      <div className="vs-insp-head">
        <span className="vs-insp-title">Проект</span>
      </div>
      <div className="vs-insp-body">
        <div className="vs-stats">
          <div>
            <b>{project.scenes.length}</b>
            <span>сцен</span>
          </div>
          <div>
            <b>{formatTime(tl.total)}</b>
            <span>длительность</span>
          </div>
          <div>
            <b>
              {ready}/{replaced.length}
            </b>
            <span>заменённых сцен готово</span>
          </div>
          <div>
            <b>
              {images}/{project.inserts.length}
            </b>
            <span>картинок вставок</span>
          </div>
        </div>
        <div className="vs-cost">
          <span>Осталось сгенерировать примерно на</span>
          <b>{money(pendingCost(project))}</b>
        </div>
        <div className="vs-how">
          <b>Как это работает</b>
          <ol>
            <li>Загрузите своё видео. Whisper разберёт речь: каждая фраза станет сценой с кадром и текстом.</li>
            <li>Добавьте фото нового ведущего (шаг 2). Если в видео несколько людей, заведите персонажа на каждого и назначьте сценам.</li>
            <li>В сценах выберите «Оригинал» или «Заменить». Заменённой сцене можно поменять текст, добавить вставки-картинки, произношение, субтитры.</li>
            <li>Превью и таймлайн работают сразу: оригинальные куски играют из вашего видео, заменённые показывают кадр ведущего до генерации.</li>
            <li>Вставки и субтитры можно двигать прямо на превью (в паузе). Экспорт: кнопка справа сверху.</li>
          </ol>
          <div className="muted small">
            Бесплатно: оригинальные куски, субтитры, музыка, перестановка сцен. Платно: каждая заменённая сцена (Seedance 2.5, {money(project.resolution === '480p' ? 0.18 : project.resolution === '720p' ? 0.36 : 0.9)}/с), картинки вставок и образы ($0.09).
          </div>
        </div>
        {serverInfo && (
          <div className="muted small vs-models">
            <div>Режим: {serverInfo.provider === 'mock' ? 'mock (без ключа)' : 'WaveSpeed'}</div>
            <div>Дубли: {serverInfo.models.take}</div>
            <div>Образы и вставки: Seedream 5 Pro</div>
            <div>Речь: {serverInfo.whisper ? serverInfo.models.whisper : 'нет (оценка)'}</div>
            <div>MP4: {serverInfo.ffmpeg ? 'ffmpeg на сервере' : 'нет ffmpeg, экспорт в WebM'}</div>
          </div>
        )}
      </div>
    </>
  );
}

export function Inspector() {
  const selection = useVideo((s) => s.selection);
  const project = useVideo((s) => s.project);
  const select = useVideo((s) => s.select);
  if (selection.type === 'insert') {
    const ins = project.inserts.find((i) => i.id === selection.id);
    if (ins) return <InsertInspector insert={ins} />;
  }
  if (selection.type === 'look') {
    const look = project.characters.find((c) => c.id === selection.characterId)?.looks.find((l) => l.id === selection.id);
    if (look) return <LookInspector characterId={selection.characterId} look={look} />;
  }
  if (selection.type === 'scene') {
    const scene = project.scenes.find((s) => s.id === selection.id);
    if (scene) return <SceneInspector scene={scene} />;
  }
  if (selection.type !== 'none' && selection.type !== 'character') select({ type: 'none' });
  return <Overview />;
}

export function SegmentedAspect() {
  const project = useVideo((s) => s.project);
  const setProject = useVideo((s) => s.setProject);
  return (
    <Segmented
      small
      value={project.aspect}
      onChange={(aspect) => setProject((p) => ({ ...p, aspect }))}
      options={[
        { value: '9:16', label: '9:16' },
        { value: '1:1', label: '1:1' },
        { value: '16:9', label: '16:9' },
      ]}
    />
  );
}
