import { useEffect, useMemo, useState } from 'react';
import { IconBreak, IconClose, IconImage, IconType } from '../../editor/Icons';
import { insertColor, tokenize } from '../script';
import { useVideo } from '../store';
import type { Insert, Scene } from '../types';

/**
 * The "no code" replacement for Hypit's <script> markup. Words are chips; drag across them to select a range,
 * then attach an insert (B-roll), a pronunciation hint, or a caption break. Inserts show as coloured underlines
 * with a thumbnail tag at their first word; clicking the tag opens the insert in the inspector.
 */
export function ScriptEditor({ scene, inserts }: { scene: Scene; inserts: Insert[] }) {
  const tokens = useMemo(() => tokenize(scene.dialogue), [scene.dialogue]);
  const allInserts = useVideo((s) => s.project.inserts);
  const addInsert = useVideo((s) => s.addInsert);
  const setPronunciation = useVideo((s) => s.setPronunciation);
  const toggleCaptionBreak = useVideo((s) => s.toggleCaptionBreak);
  const select = useVideo((s) => s.select);
  const selection = useVideo((s) => s.selection);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [pronEdit, setPronEdit] = useState<{ word: number; value: string } | null>(null);

  useEffect(() => {
    const up = () => setAnchor(null);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  useEffect(() => {
    setSel(null);
    setPronEdit(null);
  }, [scene.id]);

  const colorOf = (ins: Insert) => insertColor(allInserts.indexOf(ins));
  const pronMap = useMemo(() => new Map(scene.pronunciations.map((p) => [p.word, p.speech])), [scene.pronunciations]);
  const breakSet = useMemo(() => new Set(scene.captionBreaks), [scene.captionBreaks]);
  const covering = (i: number) => inserts.filter((x) => i >= x.startWord && i <= x.endWord);
  const selectedInsertId = selection.type === 'insert' ? selection.id : null;

  const onDown = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    setAnchor(i);
    setSel([i, i]);
    setPronEdit(null);
  };
  const onEnter = (i: number) => {
    if (anchor === null) return;
    setSel([Math.min(anchor, i), Math.max(anchor, i)]);
  };

  if (!tokens.length) return <div className="vs-script-empty">Напишите текст сцены на вкладке «Текст» — здесь его можно будет разметить.</div>;

  return (
    <div className="vs-script-wrap">
      <div className="vs-script" onMouseLeave={() => anchor !== null && setAnchor(null)}>
        {tokens.map((t, i) => {
          const cov = covering(i);
          const first = inserts.filter((x) => x.startWord === i);
          const inSel = sel && i >= sel[0] && i <= sel[1];
          const style: React.CSSProperties = {};
          if (cov.length) {
            style.borderBottomColor = colorOf(cov[0]);
            if (cov.length > 1) style.boxShadow = `0 4px 0 ${colorOf(cov[1])}`;
          }
          const pron = pronMap.get(i);
          return (
            <span key={i} className="vs-word-group">
              {first.map((ins) => (
                <button
                  key={ins.id}
                  type="button"
                  className={`vs-ins-tag ${selectedInsertId === ins.id ? 'on' : ''}`}
                  style={{ borderColor: colorOf(ins), background: ins.image ? undefined : `${colorOf(ins)}22` }}
                  title={`Вставка «${ins.name}» — открыть настройки`}
                  onClick={(e) => {
                    e.stopPropagation();
                    select({ type: 'insert', id: ins.id });
                  }}
                >
                  {ins.image ? <img src={ins.image} alt="" /> : <IconImage width={12} height={12} />}
                  <span>{ins.name}</span>
                </button>
              ))}
              <span
                className={`vs-word ${inSel ? 'sel' : ''} ${cov.length ? 'has-ins' : ''} ${pron ? 'has-pron' : ''}`}
                style={style}
                onMouseDown={(e) => onDown(i, e)}
                onMouseEnter={() => onEnter(i)}
                title={pron ? `Произносится: ${pron}` : undefined}
              >
                {t}
                {pron && <sup className="vs-pron">{pron}</sup>}
              </span>
              {breakSet.has(i) && i < tokens.length - 1 && (
                <button type="button" className="vs-break" title="Разрыв субтитра — нажмите, чтобы убрать" onClick={() => toggleCaptionBreak(scene.id, i)}>
                  <IconBreak width={12} height={12} />
                </button>
              )}
            </span>
          );
        })}
      </div>

      {sel && (
        <div className="vs-seltool">
          <span className="vs-seltool-range">
            {sel[0] === sel[1] ? `«${tokens[sel[0]]}»` : `${sel[1] - sel[0] + 1} слов: «${tokens.slice(sel[0], sel[1] + 1).join(' ')}»`}
          </span>
          <button
            type="button"
            className="ghost small"
            title="Показать картинку поверх видео, пока звучат эти слова"
            onClick={() => {
              addInsert(scene.id, sel[0], sel[1]);
              setSel(null);
            }}
          >
            <IconImage width={15} height={15} /> Вставка
          </button>
          <button
            type="button"
            className="ghost small"
            disabled={sel[0] !== sel[1]}
            title="Как ведущий должен произнести это слово (например, D → Dee)"
            onClick={() => setPronEdit({ word: sel[0], value: pronMap.get(sel[0]) ?? '' })}
          >
            <IconType width={15} height={15} /> Произношение
          </button>
          <button
            type="button"
            className="ghost small"
            disabled={sel[1] >= tokens.length - 1}
            title="Начать новую строку субтитров после выделения"
            onClick={() => {
              toggleCaptionBreak(scene.id, sel[1]);
              setSel(null);
            }}
          >
            <IconBreak width={15} height={15} /> {breakSet.has(sel[1]) ? 'Убрать разрыв' : 'Разрыв субтитра'}
          </button>
          <button type="button" className="ghost small" title="Снять выделение" onClick={() => setSel(null)}>
            <IconClose width={15} height={15} />
          </button>
        </div>
      )}

      {pronEdit && (
        <form
          className="vs-pron-edit"
          onSubmit={(e) => {
            e.preventDefault();
            setPronunciation(scene.id, pronEdit.word, pronEdit.value);
            setPronEdit(null);
            setSel(null);
          }}
        >
          <span>
            На экране «<b>{tokens[pronEdit.word]}</b>», произносить как
          </span>
          <input autoFocus value={pronEdit.value} placeholder="например, Dee" onChange={(e) => setPronEdit({ ...pronEdit, value: e.target.value })} />
          <button type="submit" className="btn primary small">
            OK
          </button>
          {pronMap.has(pronEdit.word) && (
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                setPronunciation(scene.id, pronEdit.word, null);
                setPronEdit(null);
              }}
            >
              Убрать
            </button>
          )}
        </form>
      )}

      <div className="vs-script-legend muted small">
        Потяните по словам, чтобы выделить. Цветная линия — вставка картинки; <IconBreak width={11} height={11} /> — новая строка субтитров; надстрочный текст — подсказка произношения.
      </div>
    </div>
  );
}
