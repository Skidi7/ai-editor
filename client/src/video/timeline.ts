import type { Insert, Project, Scene, WordTiming } from './types';
import { captionGroups, captionLines, estimateWordTimings, insertColor, tokenize, type CaptionWord } from './script';

/**
 * The timeline is derived from the project on every change. Scenes are laid end to end: a "keep" scene plays its
 * piece of the source video, a "replace" scene plays its generated take (or shows the character's still while the
 * take does not exist yet). Word timings come from Whisper where available and from the length heuristic otherwise.
 * Inserts and captions are anchored to words, so they follow the words wherever the words end up.
 */

export interface ClipTL {
  scene: Scene;
  index: number;
  start: number;
  end: number;
  duration: number;
  tokens: string[];
  /** Global times, one per token. */
  words: WordTiming[];
  /** Video to play (source video or generated take) and where inside it this clip begins. */
  video: string | null;
  offset: number;
  still: string | null;
  estimated: boolean;
  /** Replaced scene whose new footage does not exist yet: the original plays with a "to be replaced" label. */
  pendingReplace: boolean;
}

export interface InsertTL {
  insert: Insert;
  clip: ClipTL;
  start: number;
  end: number;
  color: string;
}

export interface CaptionWordTL extends CaptionWord {
  start: number;
  end: number;
}

export interface CaptionTL {
  clip: ClipTL;
  start: number;
  end: number;
  lines: CaptionWordTL[][];
}

export interface Timeline {
  clips: ClipTL[];
  inserts: InsertTL[];
  captions: CaptionTL[];
  total: number;
}

export function sceneCharacter(project: Project, scene: Scene) {
  return project.characters.find((c) => c.id === scene.speakerId) ?? project.characters[0] ?? null;
}

/** Image used as the first frame of a replaced scene (and as its preview until the take exists). */
export function sceneLookImage(project: Project, scene: Scene): string | null {
  const ch = sceneCharacter(project, scene);
  if (!ch) return null;
  const byId = (id: string | null) => (id ? ch.looks.find((l) => l.id === id)?.image ?? null : null);
  return byId(scene.lookId) || byId(ch.activeLookId) || ch.looks.find((l) => l.image)?.image || ch.reference;
}

/** What the preview shows for a scene when there is no video to play. */
export function sceneStill(project: Project, scene: Scene): string | null {
  if (scene.mode === 'keep') return scene.thumb;
  // Replacing inside the footage: the original frame is the right preview; new footage from a still: the still.
  if (scene.source && (replaceKindOf(scene) === 'edit' || !scene.take)) return scene.thumb || sceneLookImage(project, scene);
  return sceneLookImage(project, scene) || scene.thumb;
}

/** Kind of replacement a scene uses (edit = swap inside the footage, generate = new footage from a still). */
export function replaceKindOf(scene: Scene): 'edit' | 'generate' {
  return scene.replaceKind ?? (scene.source ? 'edit' : 'generate');
}

export function sceneDuration(scene: Scene): number {
  const srcLen = scene.source ? Math.max(0.2, scene.source.end - scene.source.start) : 0;
  if (scene.mode === 'keep' && scene.source) return srcLen;
  if (scene.take) return scene.take.source === 'edit' && scene.source ? Math.min(srcLen, scene.take.duration) : scene.take.duration;
  // Not generated yet: a replaced piece of the source keeps its original length in the plan.
  if (scene.source && replaceKindOf(scene) === 'edit') return srcLen;
  return scene.duration;
}

export function buildTimeline(project: Project): Timeline {
  const clips: ClipTL[] = [];
  let t = 0;
  project.scenes.forEach((scene, index) => {
    const tokens = tokenize(scene.dialogue);
    const duration = Math.max(0.2, sceneDuration(scene));
    const hasSource = !!scene.source && !!project.source;
    const keep = scene.mode === 'keep' && hasSource;
    const editTake = scene.mode === 'replace' && scene.take?.source === 'edit' && !!scene.take.video;
    // A replaced scene without new footage yet shows the original piece (with a label), never the character photo.
    const pendingReplace = scene.mode === 'replace' && !scene.take?.video && hasSource && !(scene.take && scene.take.source === 'mock' && replaceKindOf(scene) === 'generate');
    const usesSourceTiming = keep || editTake || pendingReplace;
    let local: WordTiming[];
    let estimated = true;
    if (usesSourceTiming && scene.sourceWords && scene.sourceWords.length === tokens.length) {
      local = scene.sourceWords;
      estimated = false;
    } else if (!usesSourceTiming && scene.take?.words && scene.take.words.length === tokens.length) {
      local = scene.take.words;
      estimated = false;
    } else {
      local = estimateWordTimings(tokens, duration, usesSourceTiming ? { lead: 0.05, tail: 0.1 } : undefined);
    }
    const words = local.map((w) => ({ start: t + Math.min(w.start, duration), end: t + Math.min(w.end, duration) }));
    let video: string | null = null;
    let offset = 0;
    if (keep || pendingReplace) {
      video = project.source!.url;
      offset = scene.source!.start;
    } else if (scene.take?.video) {
      video = scene.take.video;
    }
    clips.push({
      scene,
      index,
      start: t,
      end: t + duration,
      duration,
      tokens,
      words,
      video,
      offset,
      still: sceneStill(project, scene),
      estimated,
      pendingReplace,
    });
    t += duration;
  });

  const inserts: InsertTL[] = [];
  project.inserts.forEach((insert, i) => {
    const clip = clips.find((c) => c.scene.id === insert.sceneId);
    if (!clip || !clip.tokens.length) return;
    const a = Math.min(insert.startWord, clip.tokens.length - 1);
    const b = Math.min(Math.max(insert.endWord, a), clip.tokens.length - 1);
    const start = Math.max(clip.start, clip.words[a].start - 0.05);
    const end = Math.min(clip.end, clip.words[b].end + (insert.hold ?? 0.3));
    inserts.push({ insert, clip, start, end: Math.max(end, start + 0.4), color: insertColor(i) });
  });

  const captions: CaptionTL[] = [];
  const cs = project.style.captions;
  for (const clip of clips) {
    if (!clip.tokens.length) continue;
    const groups = captionGroups(clip.tokens, clip.scene.captionBreaks, cs.wordsPerLine, cs.lines);
    groups.forEach((group, gi) => {
      const first = clip.words[group[0].index];
      const last = clip.words[group[group.length - 1].index];
      const nextStart = gi + 1 < groups.length ? clip.words[groups[gi + 1][0].index].start : clip.end;
      const start = gi === 0 ? clip.start : first.start;
      const end = Math.min(nextStart, last.end + 0.7, clip.end);
      const lines = captionLines(group, cs.wordsPerLine).map((line) =>
        line.map((w) => ({ ...w, start: clip.words[w.index].start, end: clip.words[w.index].end })),
      );
      captions.push({ clip, start, end, lines });
    });
  }

  return { clips, inserts, captions, total: t };
}

export function clipAt(tl: Timeline, t: number): ClipTL | null {
  if (!tl.clips.length) return null;
  for (const c of tl.clips) if (t >= c.start && t < c.end) return c;
  return t >= tl.total ? tl.clips[tl.clips.length - 1] : tl.clips[0];
}

export function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
