import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconClose, IconDownload, IconSparkle, IconTrash, IconUpload } from '../editor/Icons';
import { useFaceSwap, type HeadPhoto, type Photo, type Result, type Zoom } from './store';
import type { Resolution } from './geometry';
import '../video/video.css';
import './faceswap.css';

const usd = (v: number) => `$${v < 0.1 ? v.toFixed(3).replace(/0$/, '') : v.toFixed(2)}`;

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: Array<[T, string, string?]>; onChange: (v: T) => void }) {
  return (
    <div className="vs-seg fs-seg">
      {options.map(([v, label, hint]) => (
        <button key={String(v)} type="button" className={v === value ? 'on' : ''} title={hint} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Click or drop an image file. A div (not a button): it may hold the face picker's own buttons. */
function Drop({ onFile, title, hint, children }: { onFile: (f: File) => void; title: string; hint?: string; children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`vs-dropzone fs-drop ${over ? 'over' : ''} ${children ? 'filled' : ''}`}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      {children ?? (
        <>
          <IconUpload width={24} height={24} />
          <b>{title}</b>
          {hint && <span className="small">{hint}</span>}
        </>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** Photo preview with a numbered frame per face (when there are several); a click picks the face. */
function Picker({ photo, onPick }: { photo: Photo; onPick: (i: number) => void }) {
  const W = photo.canvas.width;
  const H = photo.canvas.height;
  return (
    <div className="fs-picker" style={{ aspectRatio: `${W} / ${H}` }}>
      <img src={photo.thumb} alt="" draggable={false} />
      {photo.faces.length > 1 &&
        photo.faces.map((f, i) => {
          const pad = f.size * 0.25;
          return (
            <button
              key={i}
              type="button"
              className={`fs-face ${i === photo.selected ? 'on' : ''}`}
              style={{
                left: `${((f.box.x - pad) / W) * 100}%`,
                top: `${((f.box.y - pad) / H) * 100}%`,
                width: `${((f.box.w + pad * 2) / W) * 100}%`,
                height: `${((f.box.h + pad * 2) / H) * 100}%`,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onPick(i);
              }}
            >
              <span>{i + 1}</span>
            </button>
          );
        })}
      {photo.status === 'detecting' && (
        <div className="fs-busy">
          <span className="vs-spin small" /> Ищем лицо…
        </div>
      )}
    </div>
  );
}

function faceNote(p: Photo): string {
  if (p.status === 'detecting') return 'Ищем лицо…';
  if (p.status === 'error') return p.error ?? 'Ошибка поиска лица';
  if (p.status === 'noface') return 'Лицо не найдено';
  return p.faces.length > 1 ? `Лиц: ${p.faces.length} — кликните нужное` : 'Лицо найдено';
}

/** One person photo: the upload, the face picker and what the model will get. */
function PersonSlot({
  photo,
  onFile,
  onPick,
  body,
  label,
  onClear,
}: {
  photo: HeadPhoto | null;
  onFile: (f: File) => void;
  onPick?: (i: number) => void;
  body: boolean;
  label?: string;
  onClear?: () => void;
}) {
  const head = label ? (
    <div className="fs-slot-head">
      <b>{label}</b>
      {photo && onClear && (
        <button type="button" className="vs-linkbtn" onClick={onClear}>
          убрать
        </button>
      )}
    </div>
  ) : null;
  if (!photo) {
    return (
      <div className="fs-slot">
        {head}
        <Drop
          onFile={onFile}
          title={body ? 'Фото человека' : 'Фото лица'}
          hint={
            body
              ? 'Лучше в полный рост, лицом к камере, на светлом фоне — так обучена LoRA'
              : 'Лицо хорошо видно, волосы целиком; страница сама обрежет до головы с шеей, как у автора LoRA'
          }
        />
      </div>
    );
  }
  return (
    <div className="fs-slot">
      {head}
      <div className="fs-two">
        <Drop onFile={onFile} title="">
          <Picker photo={photo} onPick={onPick ?? (() => undefined)} />
        </Drop>
        <div className="fs-side">
          <span className="vs-field-hint">Модель увидит</span>
          {body ? (
            photo.body ? (
              <>
                <img className="fs-preview" src={photo.body.preview} alt="" />
                {photo.body.normalized && <span className="vs-field-hint">в полный рост (нормализовано)</span>}
              </>
            ) : (
              <span className="vs-field-hint fs-busy-inline">
                <span className="vs-spin small" /> Готовим…
              </span>
            )
          ) : (
            <img className="fs-preview" src={photo.preview} alt="" />
          )}
          <span className="vs-field-hint">{faceNote(photo)}</span>
          {body && photo.body && !photo.body.fullBody && (
            <span className="vs-field-hint">
              Фото не в полный рост — одежду ниже кадра модель додумает сама
            </span>
          )}
          {!body && photo.look && <span className="vs-field-hint">Причёска: {photo.look.ru}</span>}
        </div>
      </div>
    </div>
  );
}

function Setup() {
  const s = useFaceSwap();
  const plan = s.plan();
  const { each, total } = s.cost();
  const mock = s.info?.provider === 'mock';
  const body = s.settings.mode === 'body';
  // A couple in the scene: a person photo for each side.
  const pair = body ? s.pair() : null;
  const havePerson = pair ? !!(s.head || s.head2) : !!s.head;
  const reason = !havePerson
    ? body
      ? 'Загрузите фото человека'
      : 'Загрузите фото лица'
    : !s.target
      ? body
        ? 'Загрузите сцену'
        : 'Загрузите фото, где меняем голову'
      : s.head?.status === 'detecting' || s.head2?.status === 'detecting' || s.target.status === 'detecting'
        ? 'Ищем лица…'
        : null;
  return (
    <>
      <div className="fs-steps">
        <div className="vs-field fs-mode">
          <span className="vs-field-label">Что переносим</span>
          <Seg<'head' | 'body'>
            value={s.settings.mode}
            onChange={(mode) => s.setSettings({ mode })}
            options={[
              ['head', 'Голову', 'BFS Head Swap v1.1: голова с причёской, остальное фото не меняется'],
              ['body', 'Человека целиком', 'BFS Body Swap v1.0: лицо, одежда и фигура с фото человека; поза, свет и фон — со сцены'],
            ]}
          />
        </div>
        <section className="fs-step">
          <div className="fs-step-head">
            <span className="vs-step-num">1</span>
            <b>{body ? (pair ? 'Кого переносим: по фото на каждого' : 'Кого переносим') : 'Чью голову переносим'}</b>
          </div>
          <PersonSlot photo={s.head} onFile={(f) => void s.setHead(f)} onPick={s.pickHeadFace} body={body} label={pair ? 'Для человека слева' : undefined} />
          {pair && <PersonSlot photo={s.head2} onFile={(f) => void s.setHead2(f)} body label="Для человека справа" onClear={s.clearHead2} />}
          {pair && (
            <span className="vs-field-hint">
              Одно фото — заменится только этот человек, второй останется как был. Оба — сразу двое за одну генерацию (третья картинка:{' '}
              {usd(s.info?.pricesTwo?.[s.settings.quality] ?? 0.095)} вместо {usd(s.info?.prices[s.settings.quality] ?? 0.08)}).
            </span>
          )}
        </section>

        <section className="fs-step">
          <div className="fs-step-head">
            <span className="vs-step-num">2</span>
            <b>{body ? 'Куда переносим (сцена)' : 'Куда переносим'}</b>
          </div>
          {!s.target ? (
            <Drop
              onFile={(f) => void s.setTarget(f)}
              title={body ? 'Сцена' : 'Фото, где меняем голову'}
              hint={body ? 'С неё берутся поза, кадр, свет и фон; чем крупнее человек в кадре, тем точнее лицо' : 'Оно станет итоговым кадром: чем крупнее и чище, тем лучше'}
            />
          ) : (
            <div className="fs-two">
              <Drop onFile={(f) => void s.setTarget(f)} title="">
                <Picker photo={s.target} onPick={s.pickTargetFace} />
              </Drop>
              <div className="fs-side">
                <span className="vs-field-hint">{faceNote(s.target)}</span>
                {plan?.zoomed && <span className="vs-badge info">Лицо маленькое — приблизим</span>}
                {!body && s.target.look && <span className="vs-field-hint">Сейчас волосы: {s.target.look.ru}</span>}
                {body && (
                  <div className="vs-field fs-people">
                    <span className="vs-field-label">Людей на сцене</span>
                    <Seg<'auto' | 'one' | 'two'>
                      value={s.settings.people}
                      onChange={(people) => s.setSettings({ people })}
                      options={[
                        ['auto', 'Авто', 'Страница ищет людей по лицам и силуэтам'],
                        ['one', 'Один'],
                        ['two', 'Двое', 'Слева и справа: по фото на каждого'],
                      ]}
                    />
                    <span className="vs-field-hint">
                      {pair ? 'Двое: слева и справа — фото для каждого в шаге 1' : s.settings.people === 'auto' ? 'Нашли одного человека' : 'Один человек'}
                    </span>
                  </div>
                )}
                <span className="vs-field-hint">Нажмите на фото, чтобы заменить</span>
              </div>
            </div>
          )}
        </section>

        <section className="fs-step">
          <div className="fs-step-head">
            <span className="vs-step-num">3</span>
            <b>Настройки</b>
          </div>
          <div className="vs-field">
            <span className="vs-field-label">
              Качество{' '}
              <span className="vs-field-hint">
                {body ? 'автор масштабирует сцену до ~2 Мп — это 1.5K' : 'автор LoRA советует 2K: на меньших Qwen 2.1 мылит картинку'}
              </span>
            </span>
            <Seg<Resolution>
              value={s.settings.quality}
              onChange={(quality) => s.setSettings({ quality })}
              options={[
                ['1k', '1K'],
                ['1.5k', '1.5K'],
                ['2k', '2K'],
              ]}
            />
          </div>
          {!body && (
          <div className="vs-field">
            <span className="vs-field-label">
              Версия LoRA <span className="vs-field-hint">v1 мылит кожу — автор исправил это в v1.1</span>
            </span>
            <Seg<'v1.1' | 'v1.1-alt' | 'v1'>
              value={s.settings.version}
              onChange={(version) => s.setSettings({ version })}
              options={[
                ['v1.1', 'v1.1', 'Рекомендуется: кожа детальнее, поворот головы и взгляд копируются точно'],
                ['v1.1-alt', 'v1.1 alt', 'Ещё больше деталей кожи и сильнее переносит выражение (открытый рот, улыбку); поворот головы чуть менее точный'],
                ['v1', 'v1', 'Первая версия: самая мягкая, «пластиковая» кожа'],
              ]}
            />
          </div>
          )}
          {body && (
            <label className="vs-check fs-opt">
              <input type="checkbox" checked={s.settings.bodyNormalize} onChange={(e) => s.setSettings({ bodyNormalize: e.target.checked })} />
              <span>
                Сначала привести фото человека к формату LoRA{' '}
                <span className="vs-field-hint">
                  шаг из инструкции автора: Qwen 2.1 без LoRA делает из фото «в полный рост, лицом к камере, руки опущены, светлый фон» — дорисует одежду и ноги и
                  не даст позе с фото перейти в результат; отдельная генерация, +{usd(s.info?.normalizePrice ?? 0.03)} один раз на фото
                </span>
              </span>
            </label>
          )}
          <div className="vs-field">
            <span className="vs-field-label">
              Вариантов <span className="vs-field-hint">разные сиды — выберете лучший</span>
            </span>
            <Seg<number>
              value={s.settings.variants}
              onChange={(variants) => s.setSettings({ variants })}
              options={[
                [1, '1'],
                [2, '2'],
                [3, '3'],
                [4, '4'],
              ]}
            />
          </div>
          <label className="vs-field">
            <span className="vs-field-label">
              Сходство (сила LoRA){' '}
              <span className="vs-field-hint">
                {s.settings.strength.toFixed(2)} · {body ? 'автор использует 1.0' : 'если лицо похоже слабо — 1.2–1.3'}
              </span>
            </span>
            <input type="range" min={0.8} max={1.4} step={0.05} value={s.settings.strength} onChange={(e) => s.setSettings({ strength: Number(e.target.value) })} />
          </label>
          {!body && (
          <div className="vs-field">
            <span className="vs-field-label">
              Приблизить к голове <span className="vs-field-hint">для людей в полный рост: модель получит зону вокруг головы крупно</span>
            </span>
            <Seg<Zoom>
              value={s.settings.zoom}
              onChange={(zoom) => s.setSettings({ zoom })}
              options={[
                ['auto', 'Авто', 'Приближать, когда лицо меньше ~12% кадра'],
                ['on', 'Всегда'],
                ['off', 'Нет', 'Всегда отдавать модели кадр целиком'],
              ]}
            />
          </div>
          )}
          <details className="fs-more">
            <summary>Дополнительно</summary>
            {!body && (
              <label className="vs-check fs-opt">
                <input type="checkbox" checked={s.settings.hairPrompt} onChange={(e) => s.setSettings({ hairPrompt: e.target.checked })} />
                <span>
                  Описывать причёску в промпте{' '}
                  <span className="vs-field-hint">длина и цвет с фото лица; если старые волосы длиннее — просьба убрать их полностью</span>
                </span>
              </label>
            )}
            <label className="vs-field">
              <span className="vs-field-label">
                Добавить к промпту <span className="vs-field-hint">по-английски, например выражение: «soft smile»</span>
              </span>
              <input className="vs-input" maxLength={200} value={s.settings.extra} onChange={(e) => s.setSettings({ extra: e.target.value })} />
            </label>
            <label className="vs-field">
              <span className="vs-field-label">
                Сид <span className="vs-field-hint">пусто = случайный</span>
              </span>
              <input
                className="vs-input"
                inputMode="numeric"
                value={s.settings.seed}
                onChange={(e) => {
                  const d = e.target.value.replace(/[^\d]/g, '').slice(0, 10);
                  s.setSettings({ seed: d && Number(d) > 2147483647 ? '2147483647' : d });
                }}
              />
            </label>
            {s.lastPrompt && (
              <details className="fs-prompt">
                <summary>Промпт последнего запуска</summary>
                <p>{s.lastPrompt}</p>
              </details>
            )}
          </details>
        </section>
      </div>
      <div className="fs-go">
        <button type="button" className="accent fs-go-btn" disabled={!!reason || s.running} onClick={() => void s.run()}>
          {s.running ? <span className="vs-spin" /> : <IconSparkle width={18} height={18} />}
          {s.running ? 'Генерация…' : body ? 'Заменить человека' : 'Заменить голову'}
          {!s.running && <span className="fs-price">{mock ? 'mock' : usd(total)}</span>}
        </button>
        <span className="vs-field-hint">
          {reason ??
            (mock
              ? 'Mock-режим: модель не вызывается'
              : `${s.settings.variants} × ${usd(each)}${
                  body && s.settings.bodyNormalize && Math.abs(total - each * s.settings.variants) > 1e-6 ? ` + ${usd(total - each * s.settings.variants)} нормализация` : ''
                } · Qwen-Image 2.1 + LoRA BFS ${body ? 'Body Swap v1.0' : s.settings.version} · ${s.settings.quality.toUpperCase()}`)}
        </span>
      </div>
    </>
  );
}

function verdict(r: Result): { cls: string; text: string } | null {
  if (r.ratio === undefined) return null;
  if (r.ratio === null) return { cls: 'stale', text: 'Лицо в результате не найдено' };
  const x = `${r.ratio.toFixed(2)}×`;
  if (r.ratio > 1.25) return { cls: 'error', text: `Головастик · ${x}` };
  if (r.ratio > 1.12) return { cls: 'stale', text: `Голова крупнее · ${x}` };
  if (r.ratio < 0.78) return { cls: 'error', text: `Голова мала · ${x}` };
  if (r.ratio < 0.88) return { cls: 'stale', text: `Голова меньше · ${x}` };
  return { cls: 'ready', text: `Пропорции в норме · ${x}` };
}

function Compare({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const move = (x: number) => {
    const b = box.current!.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((x - b.left) / b.width) * 100)));
  };
  return (
    <div
      ref={box}
      className="fs-compare"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => e.buttons && move(e.clientX)}
    >
      <img src={before} alt="До" draggable={false} />
      <img src={after} alt="После" draggable={false} className="after" style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
      <div className="fs-divider" style={{ left: `${pos}%` }}>
        <span />
      </div>
      <span className="fs-tag left">До</span>
      <span className="fs-tag right">После</span>
    </div>
  );
}

function ResultView({ r }: { r: Result }) {
  const [tab, setTab] = useState<'compare' | 'full'>('compare');
  const download = useFaceSwap((s) => s.download);
  const remove = useFaceSwap((s) => s.remove);
  if (r.status === 'running') {
    return (
      <div className="fs-empty">
        <span className="vs-spin" /> Модель меняет голову… обычно 20–60 секунд
      </div>
    );
  }
  if (r.status === 'error') {
    return (
      <div className="fs-empty">
        <div className="vs-error">{r.error}</div>
        <button type="button" className="btn small" onClick={() => remove(r.id)}>
          Убрать
        </button>
      </div>
    );
  }
  const v = verdict(r);
  return (
    <div className="fs-result">
      <div className="fs-bar">
        <div className="vs-seg small">
          <button type="button" className={tab === 'compare' ? 'on' : ''} onClick={() => setTab('compare')}>
            До / после{r.zoomed ? ' (зона головы)' : ''}
          </button>
          <button type="button" className={tab === 'full' ? 'on' : ''} onClick={() => setTab('full')}>
            Весь кадр
          </button>
        </div>
        {v && <span className={`vs-badge ${v.cls}`}>{v.text}</span>}
        <span className="spacer" />
        <span className="vs-field-hint">
          {r.seed !== undefined && `seed ${r.seed}`}
          {r.cost ? ` · ${usd(r.cost)}` : r.mock ? ' · mock' : ''}
        </span>
        <button type="button" className="btn small primary" onClick={() => void download(r.id)}>
          <IconDownload width={15} height={15} /> PNG
        </button>
        <button type="button" className="ghost small danger" title="Удалить" onClick={() => remove(r.id)}>
          <IconTrash width={16} height={16} />
        </button>
      </div>
      <div className="fs-body">
        {tab === 'compare' && r.before && r.after && <Compare before={r.before} after={r.after} />}
        {tab === 'full' && r.url && <img className="fs-full" src={r.url} alt="Результат" />}
      </div>
    </div>
  );
}

/** The target photo, encoded once per photo (not on every render). */
function TargetPreview({ canvas }: { canvas: HTMLCanvasElement }) {
  const src = useMemo(() => canvas.toDataURL('image/jpeg', 0.85), [canvas]);
  return (
    <div className="fs-body">
      <img className="fs-full" src={src} alt="" />
    </div>
  );
}

export default function FaceSwapPage() {
  const s = useFaceSwap();
  const current = s.results.find((r) => r.id === s.selected) ?? null;
  const init = s.init;

  useEffect(() => {
    document.title = 'Face Swap';
    void init();
  }, [init]);

  return (
    <div className="app fs-app">
      <header className="topbar">
        <a className="brand" href="/" title="Все инструменты">
          <span className="brand-mark" />
          <span>Face Swap</span>
        </a>
        <div className="topbar-center">
          <div className="vs-seg">
            <button type="button" className={s.view === 'edit' ? 'on' : ''} onClick={() => s.setView('edit')}>
              Фото
            </button>
            <button type="button" className={s.view === 'result' ? 'on' : ''} onClick={() => s.setView('result')} disabled={!current}>
              Результат
            </button>
          </div>
        </div>
        <div className="topbar-right">
          <span className="vs-cost-chip">Потрачено {usd(s.spent)}</span>
        </div>
      </header>
      {s.info?.provider === 'mock' && <div className="vs-banner mock">Mock-режим: нет ключа WaveSpeed (или FACESWAP_PROVIDER=mock). Модель не вызывается, фото возвращается как есть.</div>}
      {!s.info && s.checked && <div className="vs-banner">Сервер не отвечает.</div>}
      <div className="workspace">
        <aside className="fs-left">
          <Setup />
        </aside>
        <main className="fs-main">
          {s.view === 'result' && current ? (
            <ResultView key={current.id} r={current} />
          ) : s.target ? (
            <TargetPreview canvas={s.target.canvas} />
          ) : (
            <div className="fs-empty">
              <Drop onFile={(f) => void s.setTarget(f)} title="Перетащите фото, где меняем голову" hint="или нажмите, чтобы выбрать файл" />
            </div>
          )}
        </main>
        <aside className="fs-results">
          <div className="fs-results-head">
            <b>Результаты</b>
            <span className="vs-field-hint">{s.results.length || ''}</span>
          </div>
          {!s.results.length && <p className="fs-note">Здесь появятся варианты. Каждый можно сравнить с оригиналом и скачать.</p>}
          <div className="fs-list">
            {s.results.map((r) => {
              const v = verdict(r);
              return (
                <button key={r.id} type="button" className={`fs-card ${s.view === 'result' && s.selected === r.id ? 'on' : ''}`} onClick={() => s.select(r.id)}>
                  <div className="fs-thumb">
                    {r.status === 'running' && <span className="vs-spin" />}
                    {r.status === 'error' && <span className="vs-badge error">Ошибка</span>}
                    {r.status === 'done' && r.url && <img src={r.url} alt="" />}
                  </div>
                  <span className="fs-card-label">{r.label}</span>
                  {v && <span className={`vs-badge ${v.cls}`}>{v.text}</span>}
                </button>
              );
            })}
          </div>
        </aside>
      </div>
      {s.error && (
        <div className="toast vs-toast">
          <span>{s.error}</span>
          <button type="button" className="ghost small" onClick={() => s.setError(null)}>
            <IconClose width={16} height={16} />
          </button>
        </div>
      )}
    </div>
  );
}
