import { create } from 'zustand';
import { uid } from '../editor/imageUtils';
import { analyzeSourceMedia, buildSegments, candidatesFrom } from './analysis';
import { apiAlign, apiAnalyze, apiEditStart, apiInsertImage, apiJob, apiStill, apiTakeStart, apiUpload, apiUploadInfo, type AnalyzedSegment } from './api';
import { extractThumbs, probeVideo, trimSegment } from './media';
import { applyDialogueEdit, estimateDuration, estimateWordTimings, spokenWords, stripPunct, tokenize } from './script';
import { buildTimeline, formatTime, replaceKindOf, sceneCharacter, sceneLookImage, type Timeline } from './timeline';
import {
  EDIT_MIN_SECONDS,
  EDIT_PRICE_PER_SEC,
  IMAGE_PRICE,
  TAKE_PRICE_PER_SEC,
  type BoardItem,
  type Character,
  type Insert,
  type Look,
  type Project,
  type ReplaceKind,
  type Scene,
  type SceneMode,
  type Selection,
  type Style,
  type VideoServerInfo,
  type WordTiming,
} from './types';

const STORAGE_KEY = 'video-studio.project.v2';
const CHUNK_SECONDS = 8;

// ---------- Defaults ----------

export function defaultStyle(): Style {
  return {
    captions: {
      enabled: true,
      font: 'Montserrat',
      size: 44,
      color: '#FFFFFF',
      highlight: '#008FC7',
      y: 0.55,
      wordsPerLine: 4,
      lines: 2,
      uppercase: false,
      karaoke: true,
    },
    music: { url: null, name: '', gain: 0.12 },
    background: '#090A0F',
    board: { enabled: false, items: [], top: 0.55, title: '' },
  };
}

export function newCharacter(index: number): Character {
  return {
    id: uid('char'),
    name: index === 0 ? 'Ведущий' : `Персонаж ${index + 1}`,
    reference: null,
    looks: [],
    activeLookId: null,
    voice: '',
    voiceSample: null,
    voiceSampleName: '',
    performance: 'natural-explainer',
    gesture: 'natural',
    editRhythm: 'continuous-take',
    mode: 'image',
  };
}

export function newScene(index: number, dialogue = ''): Scene {
  return {
    id: uid('scene'),
    name: `Сцена ${index + 1}`,
    mode: 'replace',
    speakerId: null,
    source: null,
    original: '',
    thumb: null,
    sourceWords: null,
    dialogue,
    action: '',
    lookId: null,
    duration: estimateDuration(dialogue),
    autoDuration: true,
    pronunciations: [],
    captionBreaks: [],
    take: null,
    status: 'idle',
  };
}

export function emptyProject(): Project {
  return {
    id: uid('project'),
    name: 'Новое видео',
    aspect: '9:16',
    resolution: '720p',
    language: 'auto',
    source: null,
    characters: [],
    scenes: [],
    inserts: [],
    style: defaultStyle(),
  };
}

function sceneTitle(text: string, index: number): string {
  const words = tokenize(text)
    .slice(0, 3)
    .map((w) => w.replace(/[.,!?;:…»"]+$/, ''))
    .filter(Boolean);
  return words.length ? words.join(' ') : `Сцена ${index + 1}`;
}

/** Scene built from a speech segment of the source video. */
function sceneFromSegment(seg: AnalyzedSegment, index: number, speakerId: string | null): Scene {
  const tokens = tokenize(seg.text);
  let sourceWords: WordTiming[] | null = null;
  if (seg.words && seg.words.length === tokens.length) {
    sourceWords = seg.words.map((w) => ({ start: Math.max(0, w.start - seg.start), end: Math.max(0, w.end - seg.start) }));
  }
  const len = seg.end - seg.start;
  return {
    ...newScene(index, seg.text),
    name: sceneTitle(seg.text, index),
    mode: 'keep',
    speakerId,
    source: { start: seg.start, end: seg.end },
    original: seg.text,
    sourceWords,
    duration: Math.min(30, Math.max(4, Math.round(len))),
    autoDuration: false,
  };
}

// ---------- Persistence ----------

function loadSaved(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Project;
    if (!p || !Array.isArray(p.scenes) || !Array.isArray(p.characters)) return null;
    p.characters = p.characters.map((c) => ({ ...c, looks: c.looks.map((l) => (l.status === 'generating' ? { ...l, status: l.image ? 'ready' : 'idle' } : l)) }));
    p.inserts = p.inserts.map((i) => (i.status === 'generating' ? { ...i, status: i.image ? 'ready' : 'idle' } : i));
    p.style = { ...defaultStyle(), ...p.style, captions: { ...defaultStyle().captions, ...p.style?.captions }, board: { ...defaultStyle().board, ...p.style?.board } };
    return p;
  } catch {
    return null;
  }
}

let saveTimer = 0;
function scheduleSave(p: Project) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch {
      /* quota — ignore */
    }
  }, 300);
}

// ---------- Cost ----------

/** Price of (re)generating a replaced scene: video-edit bills input + output seconds, new footage bills its length. */
export function takeCost(scene: Scene, project: Project): number {
  if (replaceKindOf(scene) === 'edit' && scene.source) {
    const len = Math.max(EDIT_MIN_SECONDS, Math.min(30, scene.source.end - scene.source.start));
    return Math.round(EDIT_PRICE_PER_SEC[project.resolution] * len * 2 * 100) / 100;
  }
  return Math.round(TAKE_PRICE_PER_SEC[project.resolution] * scene.duration * 100) / 100;
}

/** A take is stale when what it was made from (text, still, source range, kind of replacement) changed. */
export function takeStale(scene: Scene, project: Project): boolean {
  if (!scene.take || scene.mode !== 'replace') return false;
  const take = scene.take;
  if (take.source === 'upload') return false;
  const kind = replaceKindOf(scene);
  if (take.source === 'edit') {
    if (kind !== 'edit') return true;
    const r = take.range;
    if (!scene.source || !r || Math.abs(r.start - scene.source.start) > 0.05 || Math.abs(r.end - scene.source.end) > 0.05) return true;
    return (take.lookImage ?? null) !== sceneLookImage(project, scene);
  }
  if (kind === 'edit' && scene.source) return true;
  return take.dialogue !== scene.dialogue || (take.lookImage ?? null) !== sceneLookImage(project, scene);
}

export function pendingCost(project: Project): number {
  let c = 0;
  for (const s of project.scenes) if (s.mode === 'replace' && (!s.take || takeStale(s, project))) c += takeCost(s, project);
  for (const i of project.inserts) if (!i.image) c += IMAGE_PRICE;
  return Math.round(c * 100) / 100;
}

// ---------- Store ----------

export interface ExportState {
  status: 'idle' | 'rendering' | 'transcoding' | 'done' | 'error';
  progress: number;
  url?: string;
  format?: 'webm' | 'mp4';
  error?: string;
}

export interface VideoState {
  project: Project;
  tl: Timeline;
  selection: Selection;
  serverInfo: VideoServerInfo | null;
  error: string | null;
  notice: string | null;
  exportState: ExportState;
  playhead: number;
  playing: boolean;
  openSceneId: string | null;
  analyzing: string | null;
  transcribing: string | null;

  setProject(fn: (p: Project) => Project): void;
  select(sel: Selection): void;
  setError(msg: string | null): void;
  setNotice(msg: string | null): void;
  setServerInfo(info: VideoServerInfo | null): void;
  setPlayhead(t: number): void;
  setPlaying(v: boolean): void;
  setExportState(patch: Partial<ExportState>): void;
  setOpenScene(id: string | null): void;
  resetProject(): void;

  uploadSource(file: File): Promise<void>;
  /** Cuts the source into scenes locally (pauses + shot changes), then transcribes in the background. */
  analyzeSource(): Promise<void>;
  /** Whisper text for the existing scenes (boundaries stay as they are). */
  transcribeScenes(): Promise<void>;
  /** Replaces the scenes with Whisper phrases. */
  resplitByWhisper(): Promise<void>;
  /** Moves the boundary after `sceneId` to global time `newEnd` (both scenes must be original, contiguous pieces). */
  moveBoundary(sceneId: string, newEnd: number): void;
  startFromScript(): void;
  removeSource(): void;

  addCharacter(): string;
  updateCharacter(id: string, patch: Partial<Character>): void;
  removeCharacter(id: string): void;
  uploadCharacterPhoto(id: string, file: File): Promise<void>;
  uploadVoiceSample(id: string, file: File): Promise<void>;
  clearVoiceSample(id: string): void;
  addLook(characterId: string): string;
  updateLook(characterId: string, lookId: string, patch: Partial<Look>): void;
  generateLook(characterId: string, lookId: string): Promise<void>;
  removeLook(characterId: string, lookId: string): void;
  setActiveLook(characterId: string, lookId: string | null): void;
  setCharacterScenes(characterId: string, mode: SceneMode): void;

  addScene(): string;
  updateScene(id: string, patch: Partial<Scene>): void;
  setDialogue(id: string, text: string): void;
  setSceneMode(id: string, mode: SceneMode): void;
  setReplaceKind(id: string, kind: ReplaceKind): void;
  setSpeaker(id: string, characterId: string | null): void;
  removeScene(id: string): void;
  moveScene(id: string, dir: -1 | 1): void;
  duplicateScene(id: string): void;
  splitSceneAt(id: string, localTime: number): Promise<void>;
  /** Splits whichever scene is under the playhead, at the playhead. */
  splitAtPlayhead(): Promise<void>;
  mergeWithNext(id: string): void;
  generateTake(id: string): Promise<void>;
  resumeJobs(): void;
  uploadTakeVideo(id: string, file: File): Promise<void>;
  clearTake(id: string): void;
  alignTake(id: string): Promise<void>;

  addInsert(sceneId: string, start: number, end: number): string;
  updateInsert(id: string, patch: Partial<Insert>): void;
  removeInsert(id: string): void;
  generateInsertImage(id: string): Promise<void>;
  uploadInsertImage(id: string, file: File): Promise<void>;
  setPronunciation(sceneId: string, word: number, speech: string | null): void;
  toggleCaptionBreak(sceneId: string, word: number): void;

  updateStyle(fn: (s: Style) => Style): void;
  uploadMusic(file: File): Promise<void>;
  addBoardItem(): void;
  updateBoardItem(id: string, patch: Partial<BoardItem>): void;
  removeBoardItem(id: string): void;
  uploadBoardIcon(id: string, file: File): Promise<void>;
}

const initial = loadSaved() ?? emptyProject();

function localWordTimings(scene: Scene): WordTiming[] {
  const tokens = tokenize(scene.dialogue);
  const len = scene.source ? scene.source.end - scene.source.start : scene.take?.duration ?? scene.duration;
  if (scene.mode === 'keep' && scene.sourceWords && scene.sourceWords.length === tokens.length) return scene.sourceWords;
  if (scene.mode === 'replace' && scene.take?.words && scene.take.words.length === tokens.length) return scene.take.words;
  return estimateWordTimings(tokens, len, scene.mode === 'keep' ? { lead: 0.05, tail: 0.1 } : undefined);
}

export const useVideo = create<VideoState>((set, get) => {
  const patchScene = (id: string, fn: (s: Scene) => Scene) =>
    get().setProject((p) => ({ ...p, scenes: p.scenes.map((s) => (s.id === id ? fn(s) : s)) }));
  const patchInsert = (id: string, fn: (i: Insert) => Insert) =>
    get().setProject((p) => ({ ...p, inserts: p.inserts.map((i) => (i.id === id ? fn(i) : i)) }));
  const patchCharacter = (id: string, fn: (c: Character) => Character) =>
    get().setProject((p) => ({ ...p, characters: p.characters.map((c) => (c.id === id ? fn(c) : c)) }));
  const patchLook = (characterId: string, lookId: string, fn: (l: Look) => Look) =>
    patchCharacter(characterId, (c) => ({ ...c, looks: c.looks.map((l) => (l.id === lookId ? fn(l) : l)) }));

  async function pollTake(sceneId: string, jobId: string) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const scene = get().project.scenes.find((s) => s.id === sceneId);
      if (!scene || scene.jobId !== jobId) return;
      let job;
      try {
        job = await apiJob(jobId);
      } catch (e) {
        patchScene(sceneId, (s) => ({ ...s, status: 'error', error: (e as Error).message, jobId: undefined, progress: undefined }));
        return;
      }
      if (job.status === 'queued' || job.status === 'running') {
        patchScene(sceneId, (s) => ({ ...s, progress: `${job.message} · ${job.elapsed}s` }));
        continue;
      }
      if (job.status === 'error' || !job.result) {
        let msg = job.error || 'Генерация не удалась';
        if (/provider rejected|rejected the request|content|safety|moderation/i.test(msg)) {
          msg =
            'Сервис отклонил запрос (фильтр содержимого). Чаще всего причина в фото персонажа: откровенная одежда, известное лицо, ' +
            'нечёткое лицо. Попробуйте другое фото или «образ» с нейтральной одеждой и фоном.';
        }
        patchScene(sceneId, (s) => ({ ...s, status: 'error', error: msg, jobId: undefined, progress: undefined }));
        set({ error: msg });
        return;
      }
      const r = job.result;
      const project = get().project;
      const cur = project.scenes.find((s) => s.id === sceneId)!;
      const isEdit = job.kind === 'edit';
      if (isEdit && cur.source) {
        // The swap keeps the original timing, so the words keep their source timings: no re-alignment needed.
        const tokens = tokenize(cur.dialogue);
        const words = cur.sourceWords && cur.sourceWords.length === tokens.length ? cur.sourceWords : null;
        patchScene(sceneId, (s) => ({
          ...s,
          status: 'ready',
          error: undefined,
          jobId: undefined,
          progress: undefined,
          take: {
            video: r.video,
            remoteUrl: r.remoteUrl,
            duration: cur.source!.end - cur.source!.start,
            words,
            aligned: words ? 'whisper' : 'estimate',
            source: r.mock ? 'mock' : 'edit',
            range: { ...cur.source! },
            dialogue: cur.dialogue,
            lookImage: sceneLookImage(project, cur),
            cost: r.mock ? 0 : takeCost(cur, project),
          },
        }));
        return;
      }
      patchScene(sceneId, (s) => ({
        ...s,
        status: 'ready',
        error: undefined,
        jobId: undefined,
        progress: undefined,
        take: {
          video: r.video,
          remoteUrl: r.remoteUrl,
          duration: r.duration,
          words: null,
          aligned: 'estimate',
          source: r.mock ? 'mock' : 'seedance',
          dialogue: cur.dialogue,
          lookImage: sceneLookImage(project, cur),
          cost: r.mock ? 0 : takeCost(cur, project),
        },
      }));
      if (r.video && get().serverInfo?.whisper) void get().alignTake(sceneId);
      return;
    }
  }

  async function fillThumbs(sceneIds?: string[]) {
    const p = get().project;
    if (!p.source) return;
    const targets = p.scenes.filter((s) => s.source && (!sceneIds || sceneIds.includes(s.id)));
    if (!targets.length) return;
    try {
      const times = targets.map((s) => s.source!.start + Math.min(0.3, (s.source!.end - s.source!.start) / 2));
      const thumbs = await extractThumbs(p.source.url, times);
      const map = new Map(targets.map((s, i) => [s.id, thumbs[i]]));
      get().setProject((pp) => ({ ...pp, scenes: pp.scenes.map((s) => (map.get(s.id) && !s.thumb ? { ...s, thumb: map.get(s.id)! } : s)) }));
    } catch (e) {
      console.warn('thumbs', e);
    }
  }

  function ensureCharacter(): string {
    const p = get().project;
    if (p.characters.length) return p.characters[0].id;
    const c = newCharacter(0);
    get().setProject((pp) => ({ ...pp, characters: [c] }));
    return c.id;
  }

  return {
    project: initial,
    tl: buildTimeline(initial),
    selection: { type: 'none' },
    serverInfo: null,
    error: null,
    notice: null,
    exportState: { status: 'idle', progress: 0 },
    playhead: 0,
    playing: false,
    openSceneId: initial.scenes[0]?.id ?? null,
    analyzing: null,
    transcribing: null,

    setProject(fn) {
      const project = fn(get().project);
      set({ project, tl: buildTimeline(project) });
      scheduleSave(project);
    },
    select: (selection) => set({ selection }),
    setError: (error) => set({ error }),
    setNotice: (notice) => set({ notice }),
    setServerInfo: (serverInfo) => set({ serverInfo }),
    setPlayhead: (playhead) => set({ playhead }),
    setPlaying: (playing) => set({ playing }),
    setExportState: (patch) => set({ exportState: { ...get().exportState, ...patch } }),
    setOpenScene: (openSceneId) => set({ openSceneId }),
    resetProject() {
      const p = emptyProject();
      get().setProject(() => p);
      set({ selection: { type: 'none' }, openSceneId: null, analyzing: null });
    },

    // ---- Source video ----
    async uploadSource(file) {
      set({ analyzing: 'Загружаем видео…', error: null });
      try {
        const up = await apiUploadInfo(file, 'source');
        const url = up.url;
        const meta = await probeVideo(url);
        if (up.truncated) {
          const pct = Math.round((up.presentFraction ?? 0) * 100);
          const sec = Math.round(meta.duration * (up.presentFraction ?? 0));
          set({
            error: `Файл «${file.name}» неполный: в нём только ${pct}% данных (примерно ${sec} с из ${Math.round(meta.duration)}). Плеер покажет начало, но звук и распознавание оборвутся. Скачайте видео заново и загрузите ещё раз.`,
          });
        }
        get().setProject((p) => ({
          ...p,
          name: p.name === 'Новое видео' ? file.name.replace(/\.[^.]+$/, '') : p.name,
          source: { url, name: file.name, duration: meta.duration, width: meta.width, height: meta.height, analyzed: null },
          aspect: meta.width > meta.height * 1.2 ? '16:9' : meta.width < meta.height * 0.85 ? '9:16' : '1:1',
          scenes: [],
          inserts: [],
        }));
        set({ selection: { type: 'none' }, openSceneId: null });
        await get().analyzeSource();
      } catch (e) {
        set({ analyzing: null, error: (e as Error).message });
      }
    },
    async analyzeSource() {
      const p = get().project;
      if (!p.source) return;
      const speakerId = ensureCharacter();
      const { url } = p.source;
      let duration = Number.isFinite(p.source.duration) && p.source.duration > 0 ? p.source.duration : 0;
      set({ analyzing: 'Смотрим и слушаем видео…', error: null });
      let segments: AnalyzedSegment[] = [];
      let analyzed: 'local' | 'chunks' = 'local';
      let pausesN = 0;
      let cutsN = 0;
      let cutOff = '';
      try {
        const a = await analyzeSourceMedia(url, (msg) => set({ analyzing: msg }));
        if (!duration && a.playableEnd > 0) {
          // Duration was unknown (WebM without a header): what played is the duration.
          duration = a.playableEnd;
          get().setProject((pp) => (pp.source ? { ...pp, source: { ...pp.source, duration } } : pp));
        }
        if (!duration) throw new Error('Не удалось определить длительность видео');
        if (a.playableEnd > 1 && a.playableEnd < duration - 1.5) {
          // The file ends before its declared duration (cut-off download): plan scenes only for what plays.
          cutOff = ` Видео реально играет только до ${formatTime(a.playableEnd)} из ${formatTime(duration)}: файл неполный, сцены построены по играющей части.`;
          duration = a.playableEnd;
          get().setProject((pp) => (pp.source ? { ...pp, source: { ...pp.source, duration } } : pp));
        }
        pausesN = a.pauses.length;
        cutsN = a.cuts.length;
        const segs = buildSegments(duration, candidatesFrom(a.pauses, a.cuts));
        segments = segs.map((s) => ({ ...s, text: '' }));
        if (!a.pauses.length && !a.cuts.length) analyzed = 'chunks';
      } catch (e) {
        if (!duration) {
          set({ analyzing: null, error: (e as Error).message });
          return;
        }
        const n = Math.max(1, Math.min(200, Math.ceil(duration / CHUNK_SECONDS)));
        const len = duration / n;
        segments = Array.from({ length: n }, (_, i) => ({ start: Math.round(i * len * 100) / 100, end: Math.round((i + 1) * len * 100) / 100, text: '' }));
        analyzed = 'chunks';
      }
      try {
        const scenes = segments.map((seg, i) => sceneFromSegment(seg, i, speakerId));
        get().setProject((pp) => ({ ...pp, source: pp.source ? { ...pp.source, analyzed, transcribed: false } : null, scenes, inserts: [] }));
        set({
          analyzing: null,
          openSceneId: scenes[0]?.id ?? null,
          notice:
            (analyzed === 'local'
              ? cutsN
                ? `Нашли ${cutsN} смен кадра: ${scenes.length} сцен, по одной на план. Паузы (${pausesN}) режут только слишком длинные планы. Границы можно двигать на таймлайне.`
                : `Смен кадра нет (один план), ${scenes.length} сцен по паузам речи (${pausesN}). Границы можно двигать на таймлайне.`
              : `Паузы и смены кадра не нашлись: видео нарезано на ${scenes.length} кусков по ${CHUNK_SECONDS} с. Границы можно двигать на таймлайне.`) + cutOff,
        });
        void fillThumbs();
        if (get().serverInfo?.whisper) void get().transcribeScenes();
      } catch (e) {
        set({ analyzing: null, error: (e as Error).message });
      }
    },
    async transcribeScenes() {
      const p = get().project;
      if (!p.source || !p.scenes.some((s) => s.source)) return;
      if (get().transcribing) return;
      set({ transcribing: 'Whisper распознаёт речь…' });
      try {
        const r = await apiAnalyze({ video: p.source.url, language: p.language, duration: p.source.duration });
        if (!r || !r.segments.length) {
          set({ transcribing: null, notice: 'Whisper недоступен: текст сцен впишите вручную или попробуйте «Распознать речь» позже.' });
          return;
        }
        // Local analysis found no boundaries (one long scene): Whisper phrases become the scenes instead.
        const cur = get().project;
        const oneLong = cur.scenes.length === 1 && cur.source && cur.source.duration > 12 && !cur.scenes[0].dialogue.trim();
        if ((cur.source?.analyzed === 'chunks' || oneLong) && r.segments.length > 1 && !cur.inserts.length && !cur.scenes.some((s) => s.take)) {
          const speakerId = cur.scenes[0]?.speakerId ?? ensureCharacter();
          const scenes = r.segments.map((seg, i) => sceneFromSegment(seg, i, speakerId));
          get().setProject((pp) => ({ ...pp, source: pp.source ? { ...pp.source, analyzed: 'whisper', transcribed: true } : null, scenes }));
          set({ transcribing: null, openSceneId: scenes[0]?.id ?? null, notice: `Границы по звуку и кадрам не нашлись, поэтому сцены нарезаны по фразам Whisper: ${scenes.length} шт. Границы можно двигать на таймлайне.` });
          void fillThumbs();
          return;
        }
        // Whisper words with absolute times (segment-level output: words spread inside each phrase by length).
        const words: { text: string; start: number; end: number }[] = [];
        for (const seg of r.segments) {
          if (seg.words && seg.words.length) {
            for (const w of seg.words) words.push({ text: w.word, start: w.start, end: w.end });
            continue;
          }
          const toks = tokenize(seg.text);
          if (!toks.length) continue;
          const weights = toks.map((t) => stripPunct(t).length + 1.5);
          const total = weights.reduce((a, b) => a + b, 0) || 1;
          const span = Math.max(0.05 * toks.length, seg.end - seg.start);
          let t = seg.start;
          toks.forEach((tok, i) => {
            const d = (span * weights[i]) / total;
            words.push({ text: tok, start: t, end: t + d });
            t += d;
          });
        }
        get().setProject((pp) => {
          const scenes = pp.scenes.map((s) => {
            if (!s.source) return s;
            const mine = words.filter((w) => (w.start + w.end) / 2 >= s.source!.start && (w.start + w.end) / 2 < s.source!.end);
            if (!mine.length) return s;
            const original = mine.map((w) => w.text).join(' ');
            const sourceWords: WordTiming[] = mine.map((w) => ({ start: Math.max(0, w.start - s.source!.start), end: Math.max(0, w.end - s.source!.start) }));
            const keepUserText = s.dialogue.trim() && s.dialogue !== s.original;
            return { ...s, original, sourceWords, dialogue: keepUserText ? s.dialogue : original, name: s.name.startsWith('Сцена ') ? sceneTitle(original, pp.scenes.indexOf(s)) : s.name };
          });
          return { ...pp, scenes, source: pp.source ? { ...pp.source, transcribed: true } : null };
        });
        set({ transcribing: null, notice: `Whisper распознал ${words.length} слов и разложил их по сценам.` });
      } catch (e) {
        set({ transcribing: null, notice: `Распознать речь не удалось: ${(e as Error).message}. Текст можно вписать вручную или повторить позже.` });
      }
    },
    async resplitByWhisper() {
      const p = get().project;
      if (!p.source) return;
      const speakerId = ensureCharacter();
      set({ analyzing: 'Whisper разбирает речь на фразы…', error: null });
      try {
        const r = await apiAnalyze({ video: p.source.url, language: p.language, duration: p.source.duration });
        if (!r || !r.segments.length) throw new Error('Whisper не вернул фраз');
        const scenes = r.segments.map((seg, i) => sceneFromSegment(seg, i, speakerId));
        get().setProject((pp) => ({ ...pp, source: pp.source ? { ...pp.source, analyzed: 'whisper', transcribed: true } : null, scenes, inserts: [] }));
        set({ analyzing: null, openSceneId: scenes[0]?.id ?? null, notice: `Whisper нашёл ${scenes.length} фраз: они стали сценами.` });
        void fillThumbs();
      } catch (e) {
        set({ analyzing: null, error: (e as Error).message });
      }
    },
    moveBoundary(sceneId, newEnd) {
      const p = get().project;
      const tl = get().tl;
      const i = p.scenes.findIndex((s) => s.id === sceneId);
      const a = p.scenes[i];
      const b = p.scenes[i + 1];
      const clipA = tl.clips.find((c) => c.scene.id === sceneId);
      if (!a || !b || !clipA || !a.source || !b.source || a.mode !== 'keep' || b.mode !== 'keep') return;
      if (Math.abs(a.source.end - b.source.start) > 0.05) return;
      const minLen = 0.5;
      const boundaryAbs = Math.round(Math.min(b.source.end - minLen, Math.max(a.source.start + minLen, a.source.start + (newEnd - clipA.start))) * 100) / 100;
      // Words of both scenes with absolute source times, then re-dealt by the new boundary.
      const absWords = (s: Scene) => {
        const toks = tokenize(s.dialogue);
        const orig = tokenize(s.original);
        const timings = localWordTimings(s);
        return toks.map((t, k) => ({ text: t, orig: orig.length === toks.length ? orig[k] : t, start: s.source!.start + timings[k].start, end: s.source!.start + timings[k].end }));
      };
      const wa = absWords(a);
      const wb = absWords(b);
      const all = wa.concat(wb);
      const k = all.findIndex((w) => (w.start + w.end) / 2 >= boundaryAbs);
      const cut = k < 0 ? all.length : k;
      const mk = (s: Scene, ws: typeof all, start: number, end: number): Scene => ({
        ...s,
        source: { start, end },
        dialogue: ws.map((w) => w.text).join(' '),
        original: ws.map((w) => w.orig).join(' '),
        sourceWords: ws.length ? ws.map((w) => ({ start: Math.max(0, w.start - start), end: Math.max(0, w.end - start) })) : null,
        duration: Math.min(30, Math.max(4, Math.round(end - start))),
        take: null,
        status: 'idle',
      });
      const na = wa.length;
      const remapIndex = (globalIdx: number) => (globalIdx < cut ? { scene: a.id, idx: globalIdx } : { scene: b.id, idx: globalIdx - cut });
      const newA = mk(a, all.slice(0, cut), a.source.start, boundaryAbs);
      const newB = { ...mk(b, all.slice(cut), boundaryAbs, b.source.end), thumb: null };
      const pron = (s: Scene, base: number) => s.pronunciations.map((x) => ({ ...remapIndex(x.word + base), speech: x.speech }));
      const brk = (s: Scene, base: number) => s.captionBreaks.map((x) => remapIndex(x + base));
      const allPron = [...pron(a, 0), ...pron(b, na)];
      const allBrk = [...brk(a, 0), ...brk(b, na)];
      newA.pronunciations = allPron.filter((x) => x.scene === a.id).map((x) => ({ word: x.idx, speech: x.speech }));
      newB.pronunciations = allPron.filter((x) => x.scene === b.id).map((x) => ({ word: x.idx, speech: x.speech }));
      newA.captionBreaks = allBrk.filter((x) => x.scene === a.id).map((x) => x.idx);
      newB.captionBreaks = allBrk.filter((x) => x.scene === b.id).map((x) => x.idx);
      const inserts = p.inserts.map((ins) => {
        if (ins.sceneId !== a.id && ins.sceneId !== b.id) return ins;
        const base = ins.sceneId === a.id ? 0 : na;
        const s = remapIndex(ins.startWord + base);
        const e = remapIndex(ins.endWord + base);
        if (s.scene !== e.scene) return { ...ins, sceneId: s.scene, startWord: s.idx, endWord: s.scene === a.id ? Math.max(s.idx, cut - 1) : e.idx };
        return { ...ins, sceneId: s.scene, startWord: s.idx, endWord: e.idx };
      });
      const scenes = [...p.scenes];
      scenes.splice(i, 2, newA, newB);
      get().setProject((pp) => ({ ...pp, scenes, inserts }));
    },
    startFromScript() {
      ensureCharacter();
      const s = newScene(0);
      get().setProject((p) => ({ ...p, source: null, scenes: [s], inserts: [] }));
      set({ openSceneId: s.id, selection: { type: 'scene', id: s.id } });
    },
    removeSource() {
      get().setProject((p) => ({ ...p, source: null, scenes: [], inserts: [] }));
      set({ selection: { type: 'none' }, openSceneId: null });
    },

    // ---- Characters ----
    addCharacter() {
      const c = newCharacter(get().project.characters.length);
      get().setProject((p) => ({ ...p, characters: [...p.characters, c] }));
      set({ selection: { type: 'character', id: c.id } });
      return c.id;
    },
    updateCharacter: (id, patch) => patchCharacter(id, (c) => ({ ...c, ...patch })),
    removeCharacter(id) {
      get().setProject((p) => {
        const rest = p.characters.filter((c) => c.id !== id);
        const fallback = rest[0]?.id ?? null;
        return { ...p, characters: rest, scenes: p.scenes.map((s) => (s.speakerId === id ? { ...s, speakerId: fallback, lookId: null } : s)) };
      });
      set({ selection: { type: 'none' } });
    },
    async uploadCharacterPhoto(id, file) {
      try {
        const url = await apiUpload(file, 'reference');
        patchCharacter(id, (c) => {
          const looks = c.looks.filter((l) => l.source !== 'photo');
          const photo: Look = { id: uid('look'), name: 'Как на фото', image: url, source: 'photo', outfit: '', pose: '', setting: '', status: 'ready' };
          return { ...c, reference: url, looks: [photo, ...looks], activeLookId: photo.id };
        });
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },
    async uploadVoiceSample(id, file) {
      try {
        const url = await apiUpload(file, 'voice');
        patchCharacter(id, (c) => ({ ...c, voiceSample: url, voiceSampleName: file.name }));
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },
    clearVoiceSample: (id) => patchCharacter(id, (c) => ({ ...c, voiceSample: null, voiceSampleName: '' })),
    addLook(characterId) {
      const ch = get().project.characters.find((c) => c.id === characterId);
      const look: Look = { id: uid('look'), name: `Образ ${(ch?.looks.length ?? 0) + 1}`, image: null, source: 'generated', outfit: '', pose: '', setting: '', status: 'idle' };
      patchCharacter(characterId, (c) => ({ ...c, looks: [...c.looks, look] }));
      set({ selection: { type: 'look', characterId, id: look.id } });
      return look.id;
    },
    updateLook: (characterId, lookId, patch) => patchLook(characterId, lookId, (l) => ({ ...l, ...patch })),
    async generateLook(characterId, lookId) {
      const ch = get().project.characters.find((c) => c.id === characterId);
      const look = ch?.looks.find((l) => l.id === lookId);
      if (!ch || !look) return;
      if (!ch.reference) {
        set({ error: `Сначала загрузите фото персонажа «${ch.name}»` });
        return;
      }
      patchLook(characterId, lookId, (l) => ({ ...l, status: 'generating', error: undefined }));
      try {
        const r = await apiStill({ reference: ch.reference, outfit: look.outfit, pose: look.pose, setting: look.setting, aspect: get().project.aspect });
        patchLook(characterId, lookId, (l) => ({ ...l, image: r.url, status: 'ready' }));
        patchCharacter(characterId, (c) => (c.activeLookId ? c : { ...c, activeLookId: lookId }));
      } catch (e) {
        patchLook(characterId, lookId, (l) => ({ ...l, status: 'error', error: (e as Error).message }));
        set({ error: (e as Error).message });
      }
    },
    removeLook(characterId, lookId) {
      patchCharacter(characterId, (c) => ({ ...c, looks: c.looks.filter((l) => l.id !== lookId), activeLookId: c.activeLookId === lookId ? null : c.activeLookId }));
      get().setProject((p) => ({ ...p, scenes: p.scenes.map((s) => (s.lookId === lookId ? { ...s, lookId: null } : s)) }));
      set({ selection: { type: 'character', id: characterId } });
    },
    setActiveLook: (characterId, lookId) => patchCharacter(characterId, (c) => ({ ...c, activeLookId: lookId })),
    setCharacterScenes(characterId, mode) {
      for (const s of get().project.scenes) if ((s.speakerId ?? get().project.characters[0]?.id) === characterId) get().setSceneMode(s.id, mode);
    },

    // ---- Scenes ----
    addScene() {
      const speakerId = ensureCharacter();
      const s = { ...newScene(get().project.scenes.length), speakerId };
      get().setProject((p) => ({ ...p, scenes: [...p.scenes, s] }));
      set({ openSceneId: s.id, selection: { type: 'scene', id: s.id } });
      return s.id;
    },
    updateScene: (id, patch) => patchScene(id, (s) => ({ ...s, ...patch })),
    setDialogue(id, text) {
      get().setProject((p) => {
        const scene = p.scenes.find((s) => s.id === id);
        if (!scene) return p;
        const r = applyDialogueEdit(scene, p.inserts, text);
        return { ...p, scenes: p.scenes.map((s) => (s.id === id ? r.scene : s)), inserts: r.inserts };
      });
    },
    setSceneMode(id, mode) {
      patchScene(id, (s) => {
        if (mode === 'replace') {
          const dialogue = s.dialogue.trim() ? s.dialogue : s.original;
          const len = s.source ? s.source.end - s.source.start : 0;
          const duration = s.source ? Math.min(30, Math.max(4, Math.round(len))) : estimateDuration(dialogue);
          const replaceKind: ReplaceKind = s.replaceKind ?? (s.source ? 'edit' : 'generate');
          return { ...s, mode, replaceKind, dialogue, duration, autoDuration: !s.source, status: s.take ? 'ready' : 'idle' };
        }
        return { ...s, mode, status: 'idle', error: undefined };
      });
      if (mode === 'replace' && !get().project.characters.length) ensureCharacter();
    },
    setReplaceKind: (id, kind) => patchScene(id, (s) => ({ ...s, replaceKind: kind })),
    setSpeaker: (id, characterId) => patchScene(id, (s) => ({ ...s, speakerId: characterId, lookId: null })),
    removeScene(id) {
      get().setProject((p) => ({
        ...p,
        scenes: p.scenes.filter((s) => s.id !== id),
        inserts: p.inserts.filter((i) => i.sceneId !== id),
        style: { ...p.style, board: { ...p.style.board, items: p.style.board.items.map((b) => (b.sceneId === id ? { ...b, sceneId: null } : b)) } },
      }));
      const sel = get().selection;
      if ((sel.type === 'scene' && sel.id === id) || sel.type === 'insert') set({ selection: { type: 'none' } });
      if (get().openSceneId === id) set({ openSceneId: get().project.scenes[0]?.id ?? null });
    },
    moveScene(id, dir) {
      get().setProject((p) => {
        const i = p.scenes.findIndex((s) => s.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= p.scenes.length) return p;
        const scenes = [...p.scenes];
        [scenes[i], scenes[j]] = [scenes[j], scenes[i]];
        return { ...p, scenes };
      });
    },
    duplicateScene(id) {
      get().setProject((p) => {
        const i = p.scenes.findIndex((s) => s.id === id);
        if (i < 0) return p;
        const src = p.scenes[i];
        const copy: Scene = { ...src, id: uid('scene'), name: `${src.name} (копия)`, take: null, status: 'idle', error: undefined, jobId: undefined, progress: undefined };
        const inserts = p.inserts.filter((x) => x.sceneId === id).map((x) => ({ ...x, id: uid('ins'), sceneId: copy.id }));
        const scenes = [...p.scenes];
        scenes.splice(i + 1, 0, copy);
        return { ...p, scenes, inserts: [...p.inserts, ...inserts] };
      });
    },
    async splitSceneAt(id, localTime) {
      const p = get().project;
      const idx = p.scenes.findIndex((s) => s.id === id);
      const scene = p.scenes[idx];
      if (!scene) return;
      const len = scene.source ? scene.source.end - scene.source.start : scene.take?.duration ?? scene.duration;
      if (localTime < 0.15 || localTime > len - 0.15) {
        set({ error: 'Поставьте курсор внутри сцены (не у самого края) и нажмите «Разрезать»' });
        return;
      }
      const tokens = tokenize(scene.dialogue);
      const timings = localWordTimings(scene);
      let cut = timings.findIndex((w) => w.start >= localTime);
      if (cut < 0) cut = tokens.length;
      const origTokens = tokenize(scene.original);
      const sameOrig = origTokens.length === tokens.length;
      const a: Scene = {
        ...scene,
        dialogue: tokens.slice(0, cut).join(' '),
        original: sameOrig ? origTokens.slice(0, cut).join(' ') : scene.original,
        sourceWords: scene.sourceWords && scene.sourceWords.length === tokens.length ? scene.sourceWords.slice(0, cut) : null,
        source: scene.source ? { start: scene.source.start, end: scene.source.start + localTime } : null,
        pronunciations: scene.pronunciations.filter((x) => x.word < cut),
        captionBreaks: scene.captionBreaks.filter((x) => x < cut - 1),
        take: null,
        status: 'idle',
        error: undefined,
        jobId: undefined,
        progress: undefined,
      };
      const b: Scene = {
        ...scene,
        id: uid('scene'),
        name: sceneTitle(tokens.slice(cut).join(' '), idx + 1),
        dialogue: tokens.slice(cut).join(' '),
        original: sameOrig ? origTokens.slice(cut).join(' ') : '',
        sourceWords:
          scene.sourceWords && scene.sourceWords.length === tokens.length
            ? scene.sourceWords.slice(cut).map((w) => ({ start: Math.max(0, w.start - localTime), end: Math.max(0, w.end - localTime) }))
            : null,
        source: scene.source ? { start: scene.source.start + localTime, end: scene.source.end } : null,
        thumb: null,
        pronunciations: scene.pronunciations.filter((x) => x.word >= cut).map((x) => ({ ...x, word: x.word - cut })),
        captionBreaks: scene.captionBreaks.filter((x) => x >= cut).map((x) => x - cut),
        take: null,
        status: 'idle',
        error: undefined,
        jobId: undefined,
        progress: undefined,
      };
      for (const s of [a, b]) {
        if (s.source) s.duration = Math.min(30, Math.max(4, Math.round(s.source.end - s.source.start)));
        else s.duration = estimateDuration(s.dialogue);
      }
      const inserts = p.inserts.flatMap((ins) => {
        if (ins.sceneId !== id) return [ins];
        if (ins.startWord >= cut) return [{ ...ins, sceneId: b.id, startWord: ins.startWord - cut, endWord: ins.endWord - cut }];
        return [{ ...ins, endWord: Math.min(ins.endWord, cut - 1) }];
      });
      const scenes = [...p.scenes];
      scenes.splice(idx, 1, a, b);
      get().setProject((pp) => ({ ...pp, scenes, inserts }));
      set({ openSceneId: b.id, selection: { type: 'scene', id: b.id } });
      await fillThumbs([b.id]);
    },
    async splitAtPlayhead() {
      const t = get().playhead;
      const clip = get().tl.clips.find((c) => t >= c.start && t < c.end);
      if (!clip) {
        set({ error: 'Курсор вне сцен' });
        return;
      }
      await get().splitSceneAt(clip.scene.id, t - clip.start);
    },
    mergeWithNext(id) {
      const p = get().project;
      const i = p.scenes.findIndex((s) => s.id === id);
      const a = p.scenes[i];
      const b = p.scenes[i + 1];
      if (!a || !b) return;
      const ta = tokenize(a.dialogue);
      const lenA = a.source ? a.source.end - a.source.start : a.duration;
      const merged: Scene = {
        ...a,
        dialogue: [a.dialogue, b.dialogue].filter((x) => x.trim()).join(' '),
        original: [a.original, b.original].filter((x) => x.trim()).join(' '),
        source: a.source && b.source ? { start: a.source.start, end: b.source.end } : a.source,
        sourceWords:
          a.sourceWords && b.sourceWords && a.sourceWords.length === ta.length ? a.sourceWords.concat(b.sourceWords.map((w) => ({ start: w.start + lenA, end: w.end + lenA }))) : null,
        pronunciations: a.pronunciations.concat(b.pronunciations.map((x) => ({ ...x, word: x.word + ta.length }))),
        captionBreaks: a.captionBreaks.concat(b.captionBreaks.map((x) => x + ta.length)),
        take: null,
        status: 'idle',
        error: undefined,
        jobId: undefined,
        progress: undefined,
      };
      merged.duration = merged.source ? Math.min(30, Math.max(4, Math.round(merged.source.end - merged.source.start))) : estimateDuration(merged.dialogue);
      const inserts = p.inserts.map((ins) => (ins.sceneId === b.id ? { ...ins, sceneId: a.id, startWord: ins.startWord + ta.length, endWord: ins.endWord + ta.length } : ins));
      const scenes = [...p.scenes];
      scenes.splice(i, 2, merged);
      get().setProject((pp) => ({ ...pp, scenes, inserts, style: { ...pp.style, board: { ...pp.style.board, items: pp.style.board.items.map((it) => (it.sceneId === b.id ? { ...it, sceneId: a.id } : it)) } } }));
      set({ openSceneId: a.id, selection: { type: 'scene', id: a.id } });
    },
    async generateTake(id) {
      const p = get().project;
      const scene = p.scenes.find((s) => s.id === id);
      if (!scene) return;
      if (scene.mode !== 'replace') {
        set({ error: 'Сцена оставлена как в оригинале. Переключите её на «Заменить», чтобы сгенерировать дубль.' });
        return;
      }
      const ch = sceneCharacter(p, scene);
      const still = sceneLookImage(p, scene);
      if (!ch || !still) {
        set({ error: `Загрузите фото персонажа${ch ? ` «${ch.name}»` : ''} (шаг 2)` });
        return;
      }
      if (replaceKindOf(scene) === 'edit') {
        // Swap the person inside the original piece: cut it out in the browser, send it with the character's photo.
        if (!scene.source || !p.source) {
          set({ error: 'У этой сцены нет фрагмента исходного видео: её можно только снять заново с фото' });
          return;
        }
        const { start, end } = scene.source;
        patchScene(id, (s) => ({ ...s, status: 'generating', error: undefined, progress: 'Вырезаем фрагмент…' }));
        try {
          const blob = await trimSegment(p.source.url, start, end, (msg) => patchScene(id, (s) => ({ ...s, progress: msg })));
          patchScene(id, (s) => ({ ...s, progress: 'Загружаем фрагмент…' }));
          const clipUrl = await apiUpload(blob, 'clip');
          const r = await apiEditStart({ video: clipUrl, reference: still, duration: end - start, resolution: p.resolution, notes: scene.action });
          patchScene(id, (s) => ({ ...s, jobId: r.jobId, progress: r.mock ? 'Mock-режим: видео не генерируется' : 'В очереди Seedance video-edit…' }));
          void pollTake(id, r.jobId);
        } catch (e) {
          patchScene(id, (s) => ({ ...s, status: 'error', error: (e as Error).message, progress: undefined }));
          set({ error: (e as Error).message });
        }
        return;
      }
      if (!scene.dialogue.trim()) {
        set({ error: 'Напишите, что говорит персонаж в этой сцене' });
        return;
      }
      patchScene(id, (s) => ({ ...s, status: 'generating', error: undefined, progress: 'Отправляем…' }));
      try {
        const dialogue = spokenWords(tokenize(scene.dialogue), scene.pronunciations).join(' ');
        const r = await apiTakeStart({
          image: still,
          prompt: { dialogue, action: scene.action, voice: ch.voice, performance: ch.performance, gesture: ch.gesture, editRhythm: ch.editRhythm, language: p.language },
          duration: scene.duration,
          resolution: p.resolution,
          aspect: p.aspect,
          mode: ch.mode,
          voiceSample: ch.mode === 'reference' ? ch.voiceSample : null,
        });
        patchScene(id, (s) => ({ ...s, jobId: r.jobId, progress: r.mock ? 'Mock-режим: видео не генерируется' : 'В очереди Seedance 2.5…' }));
        void pollTake(id, r.jobId);
      } catch (e) {
        patchScene(id, (s) => ({ ...s, status: 'error', error: (e as Error).message, progress: undefined }));
        set({ error: (e as Error).message });
      }
    },
    resumeJobs() {
      for (const s of get().project.scenes) {
        if (s.status === 'generating' && s.jobId) void pollTake(s.id, s.jobId);
        else if (s.status === 'generating') patchScene(s.id, (x) => ({ ...x, status: x.take ? 'ready' : 'idle', progress: undefined }));
      }
    },
    async uploadTakeVideo(id, file) {
      patchScene(id, (s) => ({ ...s, status: 'generating', progress: 'Загружаем клип…', error: undefined }));
      try {
        const url = await apiUpload(file, 'take');
        const p = get().project;
        const scene = p.scenes.find((s) => s.id === id)!;
        patchScene(id, (s) => ({
          ...s,
          mode: 'replace',
          status: 'ready',
          progress: undefined,
          jobId: undefined,
          take: { video: url, duration: s.duration, words: null, aligned: 'estimate', source: 'upload', dialogue: s.dialogue, lookImage: sceneLookImage(p, scene), cost: 0 },
        }));
        if (get().serverInfo?.whisper) void get().alignTake(id);
      } catch (e) {
        patchScene(id, (s) => ({ ...s, status: 'error', error: (e as Error).message, progress: undefined }));
      }
    },
    clearTake: (id) => patchScene(id, (s) => ({ ...s, take: null, status: 'idle', error: undefined, jobId: undefined, progress: undefined })),
    async alignTake(id) {
      const scene = get().project.scenes.find((s) => s.id === id);
      if (!scene?.take?.video) return;
      patchScene(id, (s) => ({ ...s, progress: 'Whisper: тайминги слов…' }));
      try {
        const tokens = tokenize(scene.dialogue);
        const r = await apiAlign({
          video: scene.take.video,
          remoteUrl: scene.take.remoteUrl,
          words: spokenWords(tokens, scene.pronunciations),
          duration: scene.take.duration,
          language: get().project.language,
        });
        if (!r) {
          patchScene(id, (s) => ({ ...s, progress: undefined }));
          set({ notice: 'Whisper недоступен: тайминги слов рассчитаны приблизительно' });
          return;
        }
        const aligned = r.granularity === 'segment' ? 'whisper-segments' : 'whisper';
        patchScene(id, (s) => (s.take ? { ...s, progress: undefined, take: { ...s.take, words: r.words, aligned } } : s));
        set({ notice: `Whisper распознал ${r.heard} слов, совпало ${r.matched} из ${tokens.length}${aligned === 'whisper-segments' ? ' (тайминги по фразам)' : ''}` });
      } catch (e) {
        patchScene(id, (s) => ({ ...s, progress: undefined }));
        set({ error: `Whisper: ${(e as Error).message}. Используются приблизительные тайминги.` });
      }
    },

    // ---- Markers ----
    addInsert(sceneId, start, end) {
      const scene = get().project.scenes.find((s) => s.id === sceneId);
      const tokens = scene ? tokenize(scene.dialogue) : [];
      const label = tokens
        .slice(start, Math.min(end, start + 2) + 1)
        .map((w) => w.replace(/[.,!?;:…»"]+$/, ''))
        .join(' ');
      const ins: Insert = {
        id: uid('ins'),
        sceneId,
        startWord: start,
        endWord: end,
        name: label || 'Вставка',
        image: null,
        prompt: '',
        aspect: '4:3',
        frame: get().project.inserts.filter((i) => i.sceneId === sceneId).length % 2 ? 'right' : 'left',
        width: 58,
        motion: 'pop',
        status: 'idle',
        hold: 0.3,
      };
      get().setProject((p) => ({ ...p, inserts: [...p.inserts, ins] }));
      set({ selection: { type: 'insert', id: ins.id } });
      return ins.id;
    },
    updateInsert: (id, patch) => patchInsert(id, (i) => ({ ...i, ...patch })),
    removeInsert(id) {
      get().setProject((p) => ({ ...p, inserts: p.inserts.filter((i) => i.id !== id) }));
      const sel = get().selection;
      if (sel.type === 'insert' && sel.id === id) set({ selection: { type: 'none' } });
    },
    async generateInsertImage(id) {
      const ins = get().project.inserts.find((i) => i.id === id);
      if (!ins) return;
      if (!ins.prompt.trim()) {
        set({ error: 'Опишите, что должно быть на картинке вставки' });
        return;
      }
      patchInsert(id, (i) => ({ ...i, status: 'generating', error: undefined }));
      try {
        const r = await apiInsertImage({ prompt: ins.prompt, aspect: ins.aspect });
        patchInsert(id, (i) => ({ ...i, image: r.url, status: 'ready' }));
      } catch (e) {
        patchInsert(id, (i) => ({ ...i, status: 'error', error: (e as Error).message }));
        set({ error: (e as Error).message });
      }
    },
    async uploadInsertImage(id, file) {
      try {
        const url = await apiUpload(file, 'insert');
        patchInsert(id, (i) => ({ ...i, image: url, status: 'ready', error: undefined }));
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },
    setPronunciation(sceneId, word, speech) {
      patchScene(sceneId, (s) => {
        const rest = s.pronunciations.filter((p) => p.word !== word);
        return { ...s, pronunciations: speech && speech.trim() ? [...rest, { word, speech: speech.trim() }] : rest };
      });
    },
    toggleCaptionBreak(sceneId, word) {
      patchScene(sceneId, (s) => {
        const has = s.captionBreaks.includes(word);
        const breaks = has ? s.captionBreaks.filter((b) => b !== word) : [...s.captionBreaks, word].sort((a, b) => a - b);
        return { ...s, captionBreaks: breaks };
      });
    },

    // ---- Style ----
    updateStyle: (fn) => get().setProject((p) => ({ ...p, style: fn(p.style) })),
    async uploadMusic(file) {
      try {
        const url = await apiUpload(file, 'music');
        get().updateStyle((s) => ({ ...s, music: { ...s.music, url, name: file.name } }));
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },
    addBoardItem() {
      const item: BoardItem = { id: uid('bi'), name: 'Участник', icon: null, tier: 'B', sceneId: null };
      get().updateStyle((s) => ({ ...s, board: { ...s.board, items: [...s.board.items, item] } }));
    },
    updateBoardItem: (id, patch) => get().updateStyle((s) => ({ ...s, board: { ...s.board, items: s.board.items.map((b) => (b.id === id ? { ...b, ...patch } : b)) } })),
    removeBoardItem: (id) => get().updateStyle((s) => ({ ...s, board: { ...s.board, items: s.board.items.filter((b) => b.id !== id) } })),
    async uploadBoardIcon(id, file) {
      try {
        const url = await apiUpload(file, 'icon');
        get().updateBoardItem(id, { icon: url });
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },
  };
});

export { stripPunct };
