import { IconDownload, IconEdit, IconTrash } from '../../editor/Icons';
import { VoiceAvatar } from '../components/common';
import { useVoice } from '../store';
import { formatSeconds } from '../text';
import { usd, type HistoryItem } from '../types';
import { downloadName } from './SpeakPanel';

function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

const KIND: Record<HistoryItem['kind'], string> = { speak: 'speech', clone: 'clone', test: 'test' };

function Item({ h }: { h: HistoryItem }) {
  const removeHistory = useVoice((s) => s.removeHistory);
  const setDraft = useVoice((s) => s.setDraft);
  const select = useVoice((s) => s.select);
  const voiceById = useVoice((s) => s.voiceById);
  const setTab = useVoice((s) => s.setTab);

  return (
    <div className="vc-hist-item">
      <div className="vc-hist-top">
        <VoiceAvatar name={h.voiceName} gender={h.gender} size={24} />
        <b className="vc-hist-name">{h.voiceName}</b>
        <span className={`vc-kind ${h.kind}`}>{KIND[h.kind]}</span>
        <span className="spacer" />
        <span className="muted small">{timeAgo(h.createdAt)}</span>
      </div>
      <div className="vc-hist-text" title={h.text}>
        {h.text}
      </div>
      <audio className="vc-audio" controls preload="none" src={h.url} />
      <div className="vc-hist-foot">
        <span className="muted small">
          {[h.duration ? formatSeconds(h.duration) : null, h.speed !== 1 ? `${h.speed.toFixed(2)}×` : null, h.mock ? 'mock' : usd(h.cost)].filter(Boolean).join(' · ')}
        </span>
        <span className="spacer" />
        <a className="ghost small" href={h.url} download={downloadName(h)} title="Download">
          <IconDownload width={15} height={15} />
        </a>
        <button
          type="button"
          className="ghost small"
          title="Open the text in Text to speech"
          onClick={() => {
            setDraft(h.text);
            if (h.voiceId && voiceById(h.voiceId)) select(h.voiceId);
            else setTab('speak');
          }}
        >
          <IconEdit width={15} height={15} />
        </button>
        <button type="button" className="ghost small danger" title="Remove from history" onClick={() => removeHistory(h.id)}>
          <IconTrash width={15} height={15} />
        </button>
      </div>
    </div>
  );
}

/** Right column: everything voiced in this browser, newest first. */
export function History() {
  const history = useVoice((s) => s.history);
  const clearHistory = useVoice((s) => s.clearHistory);
  const spent = useVoice((s) => s.spent);
  return (
    <div className="vc-hist">
      <div className="vc-lib-head">
        <span className="vc-col-title">History</span>
        <span className="vc-count">{history.length}</span>
        <span className="spacer" />
        {history.length > 0 && (
          <button type="button" className="vs-linkbtn" onClick={() => window.confirm('Clear the history? The files stay on the server.') && clearHistory()}>
            clear
          </button>
        )}
      </div>
      <div className="muted small">Spent in this browser: {usd(spent)}</div>
      <div className="vc-hist-list">
        {history.map((h) => (
          <Item key={h.id} h={h} />
        ))}
        {!history.length && <div className="vc-empty small">Everything you generate shows up here, ready to replay and download.</div>}
      </div>
    </div>
  );
}
