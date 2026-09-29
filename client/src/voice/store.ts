import { create } from 'zustand';
import { ApiError, SERVER_DOWN, apiDeleteVoice, apiHealth, apiJob, apiPreparePresets, apiSaveVoice, apiSpeak, apiUpdateVoice, apiUpload, apiVoices, type SaveVoiceBody } from './api';
import { audioDuration, mergeClips } from './audio';
import type { RefHandoff } from './components/Reference';
import { detectLanguage, hasWords, splitText } from './text';
import { DEFAULT_PRICES, type AgeGroup, type Gender, type HistoryItem, type Tab, type Voice, type VoicePrices, type VoiceServerInfo } from './types';

const HISTORY_KEY = 'voice-studio.history.v1';
const STATE_KEY = 'voice-studio.state.v1';

export interface LibraryFilter {
  query: string;
  scope: 'all' | 'presets' | 'mine';
  gender: 'all' | Gender;
  age: 'all' | AgeGroup;
}

/** What a synthesis speaks with: a library voice, or an ad-hoc reference clip (voice clone tab). */
export type SpeakSource = { voice: Voice } | { sample: string; sampleText: string; name: string };

interface Persisted {
  spent: number;
  draft: string;
  speed: number;
  selectedId: string | null;
  tab: Tab;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? (JSON.parse(raw) as HistoryItem[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const persisted = loadJson<Persisted>(STATE_KEY, { spent: 0, draft: '', speed: 1, selectedId: 'grace', tab: 'speak' });

/**
 * Runs `fn` over the items, `limit` at a time. After the first failure no new item starts (each one is a paid
 * request), the ones already running are awaited, and then the first error is thrown.
 */
async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: { error: unknown } | null = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (error) {
        failed = failed ?? { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw (failed as { error: unknown }).error;
}

/**
 * Network hiccups and server errors are worth one more try; bad input, missing voices and limits are not, and neither
 * is a prediction the server already paid for (it says noRetry).
 */
function retryable(e: unknown): boolean {
  const err = e as ApiError;
  if (err.data?.noRetry) return false;
  const status = err.status ?? 0;
  return status === 0 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface VoiceState {
  info: VoiceServerInfo | null;
  presets: Voice[];
  mine: Voice[];
  loaded: boolean;
  selectedId: string | null;
  tab: Tab;
  filter: LibraryFilter;
  history: HistoryItem[];
  spent: number;
  draft: string;
  speed: number;
  /** Built-in voice clips being made on the server. */
  preparing: { message: string; ids: string[] | null } | null;
  /** Current synthesis (any tab). */
  speaking: { tab: Tab; done: number; total: number } | null;
  /** Last result per tab, shown under its button. */
  results: Partial<Record<Tab, HistoryItem>>;
  error: string | null;
  notice: string | null;
  historyOpen: boolean;
  /** A voice taken in «Capture voice» on its way to «Voice clone», which picks it up once. */
  handoff: RefHandoff | null;

  prices: () => VoicePrices;
  mock: () => boolean;
  init: () => Promise<void>;
  loadVoices: () => Promise<void>;
  voiceById: (id: string | null | undefined) => Voice | undefined;
  select: (id: string) => void;
  setTab: (tab: Tab) => void;
  setFilter: (p: Partial<LibraryFilter>) => void;
  setDraft: (text: string) => void;
  setSpeed: (speed: number) => void;
  addSpent: (usd: number) => void;
  /** Makes the anchor clips of built-in voices (missing ones, or `ids` again with `force`). */
  preparePresets: (ids?: string[] | null, force?: boolean) => Promise<boolean>;
  synthesize: (input: { tab: Tab; kind: HistoryItem['kind']; text: string; speed: number; source: SpeakSource }) => Promise<HistoryItem | null>;
  saveVoice: (body: SaveVoiceBody) => Promise<Voice | null>;
  updateVoice: (id: string, patch: Partial<SaveVoiceBody>) => Promise<boolean>;
  deleteVoice: (id: string) => Promise<void>;
  removeHistory: (id: string) => void;
  clearHistory: () => void;
  setError: (e: string | null) => void;
  setNotice: (n: string | null) => void;
  setHistoryOpen: (open: boolean) => void;
  /** Opens «Voice clone» with the file and fragment from «Capture voice». */
  sendToClone: (h: RefHandoff) => void;
  takeHandoff: () => RefHandoff | null;
}

export const useVoice = create<VoiceState>((set, get) => {
  // Small state is saved on every change (typing is debounced); the history only when it changes.
  const persist = () => {
    const s = get();
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ spent: s.spent, draft: s.draft, speed: s.speed, selectedId: s.selectedId, tab: s.tab } satisfies Persisted));
    } catch {
      /* storage full or blocked: keep working in memory */
    }
  };
  const persistHistory = () => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(get().history.slice(0, 100)));
    } catch {
      /* storage full or blocked: keep working in memory */
    }
  };
  let typingTimer = 0;
  const persistSoon = () => {
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(persist, 400);
  };

  return {
    info: null,
    presets: [],
    mine: [],
    loaded: false,
    selectedId: persisted.selectedId,
    tab: persisted.tab,
    filter: { query: '', scope: 'all', gender: 'all', age: 'all' },
    history: loadHistory(),
    spent: persisted.spent,
    draft: persisted.draft,
    speed: persisted.speed,
    preparing: null,
    speaking: null,
    results: {},
    error: null,
    notice: null,
    historyOpen: false,
    handoff: null,

    prices: () => get().info?.prices ?? DEFAULT_PRICES,
    mock: () => get().info?.provider === 'mock',

    init: async () => {
      const info = await apiHealth();
      // While the server is down the page shows a banner and keeps checking; no error toast on top of it.
      if (!info) {
        set({ info: null });
        return;
      }
      const wasDown = !get().info;
      set({ info });
      if (wasDown && get().error === SERVER_DOWN) set({ error: null });
      await get().loadVoices();
    },

    loadVoices: async () => {
      try {
        const { presets, mine } = await apiVoices();
        set({ presets, mine, loaded: true });
        const sel = get().selectedId;
        if (!sel || ![...presets, ...mine].some((v) => v.id === sel)) set({ selectedId: mine[0]?.id ?? presets.find((p) => p.sample)?.id ?? presets[0]?.id ?? null });
      } catch (e) {
        set({ error: (e as Error).message, loaded: true });
      }
    },

    voiceById: (id) => (id ? get().mine.find((v) => v.id === id) ?? get().presets.find((v) => v.id === id) : undefined),

    select: (id) => {
      set({ selectedId: id, tab: 'speak' });
      persist();
    },
    setTab: (tab) => {
      set({ tab });
      persist();
    },
    setFilter: (p) => set({ filter: { ...get().filter, ...p } }),
    setDraft: (draft) => {
      set({ draft });
      persistSoon();
    },
    setSpeed: (speed) => {
      set({ speed });
      persistSoon();
    },
    addSpent: (v) => {
      if (!v) return;
      set({ spent: Math.round((get().spent + v) * 10000) / 10000 });
      persist();
    },

    preparePresets: async (ids = null, force = false) => {
      if (get().preparing) return false;
      set({ preparing: { message: 'Starting…', ids } });
      try {
        const r = await apiPreparePresets(ids, force);
        if (r.jobId) {
          for (;;) {
            await sleep(1500);
            const job = await apiJob(r.jobId);
            set({ preparing: { message: job.message, ids } });
            if (job.status === 'error') throw new Error(job.error || 'Could not create the samples');
            if (job.status === 'done') {
              const res = job.result;
              if (res && res.total) get().addSpent((r.cost * res.ready) / res.total);
              if (res?.failed.length) set({ error: `Failed: ${res.failed.slice(0, 3).join('; ')}${res.failed.length > 3 ? '…' : ''}` });
              break;
            }
          }
        }
        await get().loadVoices();
        set({ info: (await apiHealth()) ?? get().info });
        return !ids || ids.every((id) => get().voiceById(id)?.sample);
      } catch (e) {
        set({ error: (e as Error).message });
        return false;
      } finally {
        set({ preparing: null });
      }
    },

    synthesize: async ({ tab, kind, text, speed, source }) => {
      if (get().speaking || !hasWords(text)) return null;
      const chunks = splitText(text);
      if (!chunks.length) return null;
      set({ speaking: { tab, done: 0, total: chunks.length }, error: null });
      let charged = 0;
      let sampleCost = 0;
      try {
        let voice = 'voice' in source ? source.voice : null;
        if (voice && voice.kind === 'preset' && !voice.sample) {
          if (get().info?.presetsEditable === false) throw new Error(`${voice.name} is not available yet`);
          // First use of a built-in voice: make its clip, then speak.
          const before = get().spent;
          if (!(await get().preparePresets([voice.id]))) throw new Error(`Could not create the sample for ${voice.name}`);
          sampleCost = get().spent - before;
          voice = get().voiceById(voice.id) ?? voice;
        }
        const urls: string[] = new Array(chunks.length);
        let mock = false;
        let done = 0;
        await pool(chunks, 3, async (chunk, i) => {
          const body = voice
            ? { voiceId: voice.id, text: chunk, speed }
            : { sample: (source as { sample: string }).sample, sampleText: (source as { sampleText: string }).sampleText, text: chunk, speed };
          const r = await apiSpeak(body).catch((e) => (retryable(e) ? apiSpeak(body) : Promise.reject(e)));
          urls[i] = r.url;
          charged += r.cost;
          mock = mock || !!r.mock;
          done += 1;
          set({ speaking: { tab, done, total: chunks.length } });
        });
        let url = urls[0];
        let duration: number | null;
        if (urls.length > 1) {
          const merged = await mergeClips(urls);
          url = (await apiUpload(merged.blob, 'speech')).url;
          duration = merged.duration;
        } else duration = await audioDuration(url);
        const item: HistoryItem = {
          id: `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          createdAt: Date.now(),
          kind,
          text: text.trim(),
          voiceId: voice?.id ?? null,
          voiceName: voice?.name ?? ('name' in source ? source.name : 'Voice'),
          gender: voice?.gender ?? null,
          age: voice?.age ?? null,
          url,
          duration,
          cost: Math.round((charged + sampleCost) * 10000) / 10000,
          speed,
          lang: detectLanguage(text)?.code ?? null,
          mock: mock || undefined,
        };
        set({ history: [item, ...get().history].slice(0, 100), results: { ...get().results, [tab]: item } });
        persistHistory();
        return item;
      } catch (e) {
        const err = e as ApiError;
        set({ error: err.data?.needsPrepare ? 'This voice has no sample yet: create it in the library' : err.message });
        return null;
      } finally {
        get().addSpent(charged);
        set({ speaking: null });
        persist();
      }
    },

    saveVoice: async (body) => {
      try {
        const voice = await apiSaveVoice(body);
        set({ mine: [voice, ...get().mine], selectedId: voice.id, notice: `${voice.name} is saved to My voices` });
        persist();
        return voice;
      } catch (e) {
        set({ error: (e as Error).message });
        return null;
      }
    },

    updateVoice: async (id, patch) => {
      try {
        const voice = await apiUpdateVoice(id, patch);
        set({ mine: get().mine.map((v) => (v.id === id ? voice : v)) });
        return true;
      } catch (e) {
        set({ error: (e as Error).message });
        return false;
      }
    },

    deleteVoice: async (id) => {
      try {
        await apiDeleteVoice(id);
        const mine = get().mine.filter((v) => v.id !== id);
        set({ mine, selectedId: get().selectedId === id ? mine[0]?.id ?? get().presets.find((p) => p.sample)?.id ?? null : get().selectedId });
        persist();
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    removeHistory: (id) => {
      set({ history: get().history.filter((h) => h.id !== id) });
      persistHistory();
    },
    clearHistory: () => {
      set({ history: [], results: {} });
      persistHistory();
    },
    setError: (error) => set({ error }),
    setNotice: (notice) => set({ notice }),
    setHistoryOpen: (historyOpen) => set({ historyOpen }),
    sendToClone: (handoff) => {
      set({ handoff });
      get().setTab('clone');
    },
    takeHandoff: () => {
      const h = get().handoff;
      if (h) set({ handoff: null });
      return h;
    },
  };
});

