import { IconClose, IconPlus, IconTrash, IconUpload } from '../../editor/Icons';
import { Slider, Toggle } from '../../editor/ui';
import { useVideo } from '../store';
import type { Tier } from '../types';
import { Field, UploadButton } from '../ui';

const TIERS: Tier[] = ['S', 'A', 'B', 'C', 'D'];

export function StylePanel() {
  const style = useVideo((s) => s.project.style);
  const scenes = useVideo((s) => s.project.scenes);
  const updateStyle = useVideo((s) => s.updateStyle);
  const uploadMusic = useVideo((s) => s.uploadMusic);
  const addBoardItem = useVideo((s) => s.addBoardItem);
  const updateBoardItem = useVideo((s) => s.updateBoardItem);
  const removeBoardItem = useVideo((s) => s.removeBoardItem);
  const uploadBoardIcon = useVideo((s) => s.uploadBoardIcon);
  const cs = style.captions;
  const setCaptions = (patch: Partial<typeof cs>) => updateStyle((s) => ({ ...s, captions: { ...s.captions, ...patch } }));

  return (
    <div className="vs-style">
      <div className="vs-subhead">
        <span>Субтитры</span>
        <span className="spacer" />
        <Toggle checked={cs.enabled} onChange={(v) => setCaptions({ enabled: v })} />
      </div>
      {cs.enabled && (
        <>
          <div className="vs-grid2">
            <Field label="Шрифт">
              <select className="vs-select" value={cs.font} onChange={(e) => setCaptions({ font: e.target.value })}>
                <option value="Montserrat">Montserrat</option>
                <option value="Inter">Inter</option>
                <option value="Impact">Impact</option>
                <option value="Arial Black">Arial Black</option>
              </select>
            </Field>
            <Field label="Слов в строке">
              <select className="vs-select" value={cs.wordsPerLine} onChange={(e) => setCaptions({ wordsPerLine: Number(e.target.value) })}>
                {[2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Slider label="Размер" value={cs.size} min={24} max={72} onChange={(v) => setCaptions({ size: v })} />
          <Slider label="Положение по вертикали" value={Math.round(cs.y * 100)} min={10} max={90} format={(v) => `${v}%`} onChange={(v) => setCaptions({ y: v / 100 })} />
          <div className="vs-grid2">
            <Field label="Цвет текста" row>
              <input type="color" value={cs.color} onChange={(e) => setCaptions({ color: e.target.value })} />
            </Field>
            <Field label="Подсветка слова" row>
              <input type="color" value={cs.highlight} onChange={(e) => setCaptions({ highlight: e.target.value })} />
            </Field>
            <Field label="Караоке-подсветка" row>
              <Toggle checked={cs.karaoke} onChange={(v) => setCaptions({ karaoke: v })} />
            </Field>
            <Field label="Заглавные" row>
              <Toggle checked={cs.uppercase} onChange={(v) => setCaptions({ uppercase: v })} />
            </Field>
          </div>
        </>
      )}

      <div className="vs-subhead">
        <span>Музыка</span>
      </div>
      <div className="vs-row">
        {style.music.url ? (
          <>
            <span className="vs-file">{style.music.name || 'трек'}</span>
            <button type="button" className="ghost small" title="Убрать музыку" onClick={() => updateStyle((s) => ({ ...s, music: { ...s.music, url: null, name: '' } }))}>
              <IconClose width={14} height={14} />
            </button>
          </>
        ) : (
          <UploadButton accept="audio/*" className="ghost small" onFile={(f) => void uploadMusic(f)}>
            <IconUpload width={14} height={14} /> Загрузить трек
          </UploadButton>
        )}
      </div>
      {style.music.url && <Slider label="Громкость" value={Math.round(style.music.gain * 100)} min={0} max={100} format={(v) => `${v}%`} onChange={(v) => updateStyle((s) => ({ ...s, music: { ...s.music, gain: v / 100 } }))} />}

      <div className="vs-subhead">
        <span>Доска рейтинга (tier list)</span>
        <span className="spacer" />
        <Toggle checked={style.board.enabled} onChange={(v) => updateStyle((s) => ({ ...s, board: { ...s.board, enabled: v } }))} />
      </div>
      {style.board.enabled && (
        <>
          <Slider label="Верх доски" value={Math.round(style.board.top * 100)} min={30} max={80} format={(v) => `${v}%`} onChange={(v) => updateStyle((s) => ({ ...s, board: { ...s.board, top: v / 100 } }))} />
          <div className="vs-board-items">
            {style.board.items.map((it) => (
              <div key={it.id} className="vs-board-item">
                <UploadButton accept="image/*" className="vs-board-icon" onFile={(f) => void uploadBoardIcon(it.id, f)} title="Иконка участника">
                  {it.icon ? <img src={it.icon} alt="" /> : <IconUpload width={14} height={14} />}
                </UploadButton>
                <input className="vs-inline-input" value={it.name} onChange={(e) => updateBoardItem(it.id, { name: e.target.value })} />
                <select className="vs-select small" value={it.tier} onChange={(e) => updateBoardItem(it.id, { tier: e.target.value as Tier })}>
                  {TIERS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select className="vs-select small" value={it.sceneId ?? ''} title="Когда появляется" onChange={(e) => updateBoardItem(it.id, { sceneId: e.target.value || null })}>
                  <option value="">Сразу</option>
                  {scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      В «{s.name}»
                    </option>
                  ))}
                </select>
                <button type="button" className="ghost small danger" onClick={() => removeBoardItem(it.id)}>
                  <IconTrash width={14} height={14} />
                </button>
              </div>
            ))}
            <button type="button" className="ghost small" onClick={addBoardItem}>
              <IconPlus width={14} height={14} /> Участник
            </button>
          </div>
        </>
      )}

      <div className="vs-subhead">
        <span>Фон</span>
        <span className="spacer" />
        <input type="color" value={style.background} onChange={(e) => updateStyle((s) => ({ ...s, background: e.target.value }))} />
      </div>
    </div>
  );
}
