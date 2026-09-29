import { useEffect, useState } from 'react';
import { IconClose, IconDownload, IconFilm, IconImage, IconUpload, IconUser } from '../editor/Icons';
import { apiTranscode, apiVideoHealth } from './api';
import { exportVideo } from './exporter';
import { CharactersPanel } from './panels/CharactersPanel';
import { Inspector, SegmentedAspect } from './panels/Inspector';
import { ScenesPanel } from './panels/ScenesPanel';
import { SourcePanel } from './panels/SourcePanel';
import { StylePanel } from './panels/StylePanel';
import { currentPlayer } from './player';
import { Preview } from './Preview';
import { pendingCost, useVideo } from './store';
import { EXPORT_SIZE, type Resolution } from './types';
import { Segmented, money } from './ui';
import './video.css';

function Step({ n, title, summary, icon, children, open, onToggle }: { n: number; title: string; summary?: string; icon: React.ReactNode; children: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <section className={`vs-step ${open ? 'open' : ''}`}>
      <div className="vs-step-head" role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
        <span className="vs-step-num">{n}</span>
        <span className="vs-step-icon">{icon}</span>
        <span className="vs-step-title">
          <span className="vs-step-name">{title}</span>
          {summary && <span className="vs-step-sum">{summary}</span>}
        </span>
        <span className="vs-step-chev">{open ? '−' : '+'}</span>
      </div>
      {open && <div className="vs-step-body">{children}</div>}
    </section>
  );
}

function ExportModal() {
  const exportState = useVideo((s) => s.exportState);
  const setExportState = useVideo((s) => s.setExportState);
  const project = useVideo((s) => s.project);
  if (exportState.status === 'idle') return null;
  const close = () => setExportState({ status: 'idle', progress: 0, url: undefined, error: undefined });
  return (
    <div className="vs-modal-backdrop">
      <div className="vs-modal">
        <div className="vs-insp-head">
          <span className="vs-insp-title">Экспорт видео</span>
          <span className="spacer" />
          {(exportState.status === 'done' || exportState.status === 'error') && (
            <button type="button" className="ghost small" onClick={close}>
              <IconClose width={16} height={16} />
            </button>
          )}
        </div>
        <div className="vs-insp-body">
          {exportState.status === 'rendering' && (
            <>
              <div>Записываем композицию в реальном времени. Не сворачивайте вкладку.</div>
              <div className="vs-progress">
                <span style={{ width: `${Math.round(exportState.progress * 100)}%` }} />
              </div>
              <div className="muted small">{Math.round(exportState.progress * 100)}%</div>
            </>
          )}
          {exportState.status === 'transcoding' && <div>Конвертируем в MP4 (ffmpeg на сервере)…</div>}
          {exportState.status === 'error' && <div className="vs-error">{exportState.error}</div>}
          {exportState.status === 'done' && exportState.url && (
            <>
              <video className="vs-take-video" controls src={exportState.url} />
              <a className="btn primary wide" href={exportState.url} download={`${project.name.replace(/[^\w\-]+/g, '_') || 'video'}.${exportState.format}`}>
                <IconDownload width={16} height={16} /> Скачать {exportState.format?.toUpperCase()}
              </a>
              {exportState.format === 'webm' && <div className="muted small">MP4 появится автоматически, если на сервере установлен ffmpeg (FFMPEG_PATH в server/.env).</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function VideoStudio() {
  const project = useVideo((s) => s.project);
  const tl = useVideo((s) => s.tl);
  const error = useVideo((s) => s.error);
  const notice = useVideo((s) => s.notice);
  const setError = useVideo((s) => s.setError);
  const setNotice = useVideo((s) => s.setNotice);
  const setServerInfo = useVideo((s) => s.setServerInfo);
  const serverInfo = useVideo((s) => s.serverInfo);
  const setProject = useVideo((s) => s.setProject);
  const resumeJobs = useVideo((s) => s.resumeJobs);
  const resetProject = useVideo((s) => s.resetProject);
  const exportState = useVideo((s) => s.exportState);
  const setExportState = useVideo((s) => s.setExportState);
  const analyzing = useVideo((s) => s.analyzing);
  const [openStep, setOpenStep] = useState<number>(project.source ? 3 : 1);

  useEffect(() => {
    document.title = 'Video Studio';
    void apiVideoHealth().then((info) => {
      setServerInfo(info);
      resumeJobs();
    });
    // Re-probe connectivity every 30 s so the banner disappears as soon as the network is back.
    const t = window.setInterval(() => void apiVideoHealth().then((info) => info && setServerInfo(info)), 30000);
    return () => window.clearInterval(t);
  }, [setServerInfo, resumeJobs]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice, setNotice]);

  // After the source video is analysed, jump to the scenes step.
  useEffect(() => {
    if (project.source?.analyzed && !analyzing) setOpenStep((s) => (s === 1 ? 3 : s));
  }, [project.source?.analyzed, analyzing]);

  const exporting = exportState.status === 'rendering' || exportState.status === 'transcoding';

  const onExport = async () => {
    const player = currentPlayer();
    if (!player || !tl.total) return;
    const size = EXPORT_SIZE[project.resolution][project.aspect];
    setExportState({ status: 'rendering', progress: 0, url: undefined, error: undefined });
    try {
      const blob = await exportVideo(player, size.w, size.h, { onProgress: (p) => setExportState({ progress: p }) });
      let url = URL.createObjectURL(blob);
      let format: 'webm' | 'mp4' = blob.type.includes('mp4') ? 'mp4' : 'webm';
      if (format === 'webm' && serverInfo?.ffmpeg) {
        setExportState({ status: 'transcoding' });
        const mp4 = await apiTranscode(blob).catch(() => null);
        if (mp4) {
          url = mp4;
          format = 'mp4';
        }
      }
      setExportState({ status: 'done', url, format, progress: 1 });
    } catch (e) {
      setExportState({ status: 'error', error: (e as Error).message });
    }
  };

  const replaced = project.scenes.filter((s) => s.mode === 'replace');
  const ready = replaced.filter((s) => s.take).length;
  const withPhoto = project.characters.filter((c) => c.reference).length;
  const toggle = (n: number) => setOpenStep((s) => (s === n ? 0 : n));

  return (
    <div className="app vs-app">
      <header className="topbar">
        <a className="brand" href="/" title="Все инструменты">
          <span className="brand-mark" />
          <span>Video Studio</span>
        </a>
        <input className="vs-project-name" value={project.name} onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))} />
        <div className="topbar-center">
          <div className="vs-topbar-opts">
            <SegmentedAspect />
            <Segmented<Resolution>
              small
              value={project.resolution}
              onChange={(resolution) => setProject((p) => ({ ...p, resolution }))}
              options={[
                { value: '480p', label: '480p', title: '$0.18 / с' },
                { value: '720p', label: '720p', title: '$0.36 / с' },
                { value: '1080p', label: '1080p', title: '$0.90 / с' },
              ]}
            />
            <span className="vs-cost-chip" title="Примерная стоимость генераций, которые ещё не сделаны (Seedance 2.5 + Seedream 5 Pro)">
              ≈ {money(pendingCost(project))}
            </span>
          </div>
        </div>
        <div className="topbar-right">
          <button type="button" className="ghost small" onClick={() => window.confirm('Начать новый проект? Текущий будет очищен.') && resetProject()}>
            Новый проект
          </button>
          <span className="divider" />
          <button type="button" className="btn primary" disabled={exporting || !tl.total} onClick={() => void onExport()} title="Записать видео из превью">
            <IconDownload width={16} height={16} /> Экспорт
          </button>
        </div>
      </header>

      {serverInfo && serverInfo.provider === 'wavespeed' && serverInfo.reachable === false && (
        <div className="vs-banner">
          Нет связи с api.wavespeed.ai: сервер не может достучаться до WaveSpeed (сеть / VPN). Ключ тут ни при чём. Распознавание речи и генерации не пройдут, пока связь не восстановится. Проверка повторяется каждые 30 с.
        </div>
      )}
      {serverInfo && serverInfo.provider === 'mock' && <div className="vs-banner mock">Mock-режим: ключ WaveSpeed не задан в server/.env, генерации и распознавание речи отключены.</div>}

      <div className="workspace vs-workspace">
        <aside className="vs-steps">
          <Step
            n={1}
            title="Исходное видео"
            icon={<IconUpload width={18} height={18} />}
            summary={analyzing ? analyzing : project.source ? `${project.source.name} · ${project.scenes.length} сцен` : 'загрузите видео, которое переделываем'}
            open={openStep === 1}
            onToggle={() => toggle(1)}
          >
            <SourcePanel />
          </Step>
          <Step
            n={2}
            title="Персонажи"
            icon={<IconUser width={18} height={18} />}
            summary={project.characters.length ? `${project.characters.length} · с фото: ${withPhoto}` : 'кто будет говорить вместо оригинала'}
            open={openStep === 2}
            onToggle={() => toggle(2)}
          >
            <CharactersPanel />
          </Step>
          <Step
            n={3}
            title="Сцены"
            icon={<IconFilm width={18} height={18} />}
            summary={project.scenes.length ? `${project.scenes.length} сцен · заменить ${replaced.length} · дублей готово ${ready}` : 'что оставить, что заменить'}
            open={openStep === 3}
            onToggle={() => toggle(3)}
          >
            <ScenesPanel />
          </Step>
          <Step n={4} title="Оформление" icon={<IconImage width={18} height={18} />} summary="субтитры, музыка, доска" open={openStep === 4} onToggle={() => toggle(4)}>
            <StylePanel />
          </Step>
        </aside>

        <main className="vs-main">
          <Preview />
        </main>

        <aside className="vs-inspector">
          <Inspector />
        </aside>
      </div>

      {error && (
        <div className="toast vs-toast">
          <span>{error}</span>
          <button type="button" className="ghost small" onClick={() => setError(null)}>
            <IconClose width={16} height={16} />
          </button>
        </div>
      )}
      {notice && !error && (
        <div className="toast vs-toast info">
          <span>{notice}</span>
          <button type="button" className="ghost small" onClick={() => setNotice(null)}>
            <IconClose width={16} height={16} />
          </button>
        </div>
      )}
      <ExportModal />
    </div>
  );
}
