import { useEffect, useState, type ReactNode } from 'react';
import { IconClose, IconCopy, IconFilm, IconSparkle, IconWave } from '../editor/Icons';
import { CapturePanel } from './panels/CapturePanel';
import { ClonePanel } from './panels/ClonePanel';
import { DesignPanel } from './panels/DesignPanel';
import { History } from './panels/History';
import { Library } from './panels/Library';
import { SpeakPanel } from './panels/SpeakPanel';
import { stopPlayback } from './playback';
import { useVoice } from './store';
import { usd, type Tab } from './types';
import '../video/video.css';
import './voice.css';

const TABS: { id: Tab; label: string; icon: ReactNode; hint: string }[] = [
  { id: 'speak', label: 'Text to speech', icon: <IconWave width={16} height={16} />, hint: 'Pick a voice from the library and voice any text' },
  { id: 'design', label: 'Create voice', icon: <IconSparkle width={16} height={16} />, hint: 'A new voice from a description: age, timbre, manner' },
  { id: 'capture', label: 'Capture voice', icon: <IconFilm width={16} height={16} />, hint: 'Take a voice from a video or audio file and save it' },
  { id: 'clone', label: 'Voice clone', icon: <IconCopy width={16} height={16} />, hint: 'Your audio + text → the text in that voice' },
];

export default function VoiceStudio() {
  const tab = useVoice((s) => s.tab);
  const setTab = useVoice((s) => s.setTab);
  const init = useVoice((s) => s.init);
  const info = useVoice((s) => s.info);
  const spent = useVoice((s) => s.spent);
  const error = useVoice((s) => s.error);
  const notice = useVoice((s) => s.notice);
  const setError = useVoice((s) => s.setError);
  const setNotice = useVoice((s) => s.setNotice);
  const historyOpen = useVoice((s) => s.historyOpen);
  const setHistoryOpen = useVoice((s) => s.setHistoryOpen);
  const historyCount = useVoice((s) => s.history.length);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    document.title = 'Voice Studio';
    // The shared index.html says lang="ru" for the other tools; this page is English.
    const lang = document.documentElement.lang;
    document.documentElement.lang = 'en';
    void init().finally(() => setChecked(true));
    return () => {
      document.documentElement.lang = lang;
    };
  }, [init]);

  // Server down at start: keep checking quietly until it answers.
  useEffect(() => {
    if (info || !checked) return;
    const t = window.setInterval(() => void init(), 10000);
    return () => window.clearInterval(t);
  }, [info, checked, init]);

  // Leaving a tab silences its players: they are hidden then, so nothing on screen could stop them. A library
  // sample keeps playing, its button stays in view.
  useEffect(() => {
    if (document.querySelector('.vc-main .vc-play.on')) stopPlayback();
    document.querySelectorAll<HTMLAudioElement>('.vc-main audio').forEach((a) => a.pause());
  }, [tab]);

  // The history drawer (narrow windows) closes on Escape and on a click outside it.
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setHistoryOpen(false);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!document.querySelector('.vc-history')?.contains(target) && !document.querySelector('.vc-hist-toggle')?.contains(target)) setHistoryOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [historyOpen, setHistoryOpen]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice, setNotice]);

  return (
    <div className="app vc-app">
      <header className="topbar">
        <a className="brand" href="/" title="All tools">
          <span className="brand-mark" />
          <span>Voice Studio</span>
        </a>
        <nav className="vc-tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} title={t.hint} onClick={() => setTab(t.id)}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <button type="button" className="ghost small vc-hist-toggle" onClick={() => setHistoryOpen(!historyOpen)}>
            History · {historyCount}
          </button>
          <span className="vs-cost-chip" title="Spent on generations in this browser">
            Spent {usd(spent)}
          </span>
        </div>
      </header>

      {info?.provider === 'mock' && (
        <div className="vs-banner mock">Mock mode: no WaveSpeed key (or VOICE_PROVIDER=mock). Voices are replaced with synthetic sound, nothing is charged.</div>
      )}
      {!info && checked && <div className="vs-banner">The server is not responding. Checking again every 10 seconds…</div>}

      <div className="workspace vc-workspace">
        <aside className="vc-library">
          <Library />
        </aside>
        <main className="vc-main">
          {/* All tabs stay mounted: switching tabs keeps loaded files, variants and results. */}
          <div hidden={tab !== 'speak'}>
            <SpeakPanel active={tab === 'speak'} />
          </div>
          <div hidden={tab !== 'design'}>
            <DesignPanel />
          </div>
          <div hidden={tab !== 'capture'}>
            <CapturePanel active={tab === 'capture'} />
          </div>
          <div hidden={tab !== 'clone'}>
            <ClonePanel active={tab === 'clone'} />
          </div>
        </main>
        <aside className={`vc-history ${historyOpen ? 'open' : ''}`}>
          <History />
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
    </div>
  );
}
