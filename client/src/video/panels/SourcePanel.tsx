import { IconRefresh, IconTrash, IconType, IconUpload } from '../../editor/Icons';
import { useVideo } from '../store';
import { formatTime } from '../timeline';
import { Field, Spinner, UploadButton } from '../ui';

/** Step 1: the video to clone. Uploading it cuts it into scenes by pauses and shot changes; Whisper adds the words. */
export function SourcePanel() {
  const source = useVideo((s) => s.project.source);
  const language = useVideo((s) => s.project.language);
  const scenes = useVideo((s) => s.project.scenes);
  const analyzing = useVideo((s) => s.analyzing);
  const transcribing = useVideo((s) => s.transcribing);
  const serverInfo = useVideo((s) => s.serverInfo);
  const uploadSource = useVideo((s) => s.uploadSource);
  const analyzeSource = useVideo((s) => s.analyzeSource);
  const transcribeScenes = useVideo((s) => s.transcribeScenes);
  const resplitByWhisper = useVideo((s) => s.resplitByWhisper);
  const removeSource = useVideo((s) => s.removeSource);
  const startFromScript = useVideo((s) => s.startFromScript);
  const setProject = useVideo((s) => s.setProject);
  const whisper = !!serverInfo?.whisper;

  const langSelect = (
    <Field label="Язык речи в видео" hint="для распознавания и генерации">
      <select className="vs-select" value={language} onChange={(e) => setProject((p) => ({ ...p, language: e.target.value }))}>
        <option value="auto">Определить автоматически</option>
        <option value="ru">Русский</option>
        <option value="en">English</option>
        <option value="es">Español</option>
        <option value="de">Deutsch</option>
        <option value="fr">Français</option>
        <option value="pt">Português</option>
        <option value="ja">日本語</option>
        <option value="zh">中文</option>
      </select>
    </Field>
  );

  if (analyzing) {
    return (
      <div className="vs-source">
        <div className="vs-analyzing">
          <Spinner />
          <div>
            <b>{analyzing}</b>
            <div className="muted small">Это делается прямо в браузере, обычно 5–30 секунд. Сцены режутся там, где в речи пауза или меняется кадр.</div>
          </div>
        </div>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="vs-source">
        <UploadButton accept="video/*" className="vs-dropzone big" onFile={(f) => void uploadSource(f)}>
          <IconUpload width={30} height={30} />
          <b>Загрузите видео, которое будем переделывать</b>
          <span className="muted small">MP4 / WebM / MOV. Разрежем на сцены по паузам речи и сменам кадра, распознаем слова, а вы решите, что заменить: ведущего, текст, вставки.</span>
        </UploadButton>
        {langSelect}
        <div className="vs-row">
          <span className="muted small">Нет исходного видео?</span>
          <button type="button" className="vs-linkbtn" onClick={startFromScript}>
            Начать со сценария: написать текст и сгенерировать всё с нуля
          </button>
        </div>
      </div>
    );
  }

  const cutBy = source.analyzed === 'whisper' ? 'по фразам Whisper' : source.analyzed === 'local' ? 'по паузам речи и сменам кадра' : source.analyzed === 'chunks' ? 'на равные куски' : '';

  return (
    <div className="vs-source">
      <div className="vs-source-card">
        <video className="vs-source-video" src={source.url} controls preload="metadata" />
        <div className="vs-source-info">
          <b className="vs-source-name" title={source.name}>
            {source.name}
          </b>
          <div className="muted small">
            {formatTime(source.duration)} · {source.width}×{source.height}
          </div>
          {source.analyzed && (
            <div className="small">
              {scenes.length} сцен {cutBy}. Границы можно тянуть на таймлайне.
            </div>
          )}
          {transcribing ? (
            <div className="small vs-row">
              <Spinner small /> {transcribing}
            </div>
          ) : source.transcribed ? (
            <div className="small muted">Текст распознан (Whisper)</div>
          ) : (
            <div className="small vs-warn">Текст сцен ещё не распознан{whisper ? '' : ': Whisper недоступен, впишите вручную'}</div>
          )}
        </div>
      </div>
      {langSelect}
      <div className="vs-row">
        {whisper && !source.transcribed && (
          <button type="button" className="btn small" disabled={!!transcribing} onClick={() => void transcribeScenes()} title="Распознать слова и разложить их по текущим сценам">
            <IconType width={14} height={14} /> Распознать речь
          </button>
        )}
        <button type="button" className="ghost small" onClick={() => void analyzeSource()} title="Заново найти границы по паузам и сменам кадра (текущие сцены будут заменены)">
          <IconRefresh width={14} height={14} /> Разбить заново
        </button>
        {whisper && (
          <button type="button" className="ghost small" onClick={() => void resplitByWhisper()} title="Одна фраза = одна сцена (текущие сцены будут заменены)">
            По фразам Whisper
          </button>
        )}
      </div>
      <div className="vs-row">
        <UploadButton accept="video/*" className="ghost small" onFile={(f) => void uploadSource(f)}>
          <IconUpload width={14} height={14} /> Другое видео
        </UploadButton>
        <span className="spacer" />
        <button type="button" className="ghost small danger" onClick={() => window.confirm('Убрать исходное видео и все сцены?') && removeSource()}>
          <IconTrash width={14} height={14} />
        </button>
      </div>
    </div>
  );
}
