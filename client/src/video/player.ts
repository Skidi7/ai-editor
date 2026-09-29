import { drawFrame, type Assets, type DrawOptions, type FrameLayout } from './compositor';
import { clipAt, type ClipTL, type Timeline } from './timeline';
import type { Project } from './types';

let current: Player | null = null;
/** The preview's player, shared with the export button. */
export function currentPlayer(): Player | null {
  return current;
}
export function setCurrentPlayer(p: Player | null) {
  current = p;
}

interface Slot {
  el: HTMLVideoElement;
  src: string;
  isTake: boolean;
}

/**
 * Playback engine for the preview and the export.
 * One <video> per distinct file: every original scene of the source video shares the same element, so the
 * playhead crossing from one scene straight into the next one never seeks (no stutter, no repeated frames).
 * Generated takes get their own element each. While a video plays, its own clock drives the timeline so audio
 * and picture never drift apart.
 */
export class Player implements Assets {
  project: Project;
  tl: Timeline;
  time = 0;
  playing = false;
  onDuration?: (sceneId: string, duration: number) => void;
  onEnded?: () => void;

  private images = new Map<string, HTMLImageElement>();
  private videos = new Map<string, Slot>();
  private music: HTMLAudioElement | null = null;
  private musicSrc = '';
  private raf = 0;
  private lastNow = 0;
  private activeSrc: string | null = null;
  private activeSceneId: string | null = null;
  private listeners = new Set<() => void>();
  private audioCtx: AudioContext | null = null;
  private sources = new Map<HTMLMediaElement, MediaElementAudioSourceNode>();
  private recDest: MediaStreamAudioDestinationNode | null = null;
  private disposed = false;

  constructor(project: Project, tl: Timeline) {
    this.project = project;
    this.tl = tl;
    this.sync();
    this.raf = requestAnimationFrame(this.tick);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setProject(project: Project, tl: Timeline) {
    this.project = project;
    this.tl = tl;
    this.sync();
    if (this.time > tl.total) this.time = tl.total;
  }

  // ---- Assets ----
  image(url: string | null): HTMLImageElement | null {
    if (!url) return null;
    let img = this.images.get(url);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = url;
      this.images.set(url, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** The element to draw for a scene: only when it holds a decoded frame at (about) the right position. */
  video(sceneId: string): HTMLVideoElement | null {
    const clip = this.tl.clips.find((c) => c.scene.id === sceneId);
    if (!clip?.video) return null;
    const slot = this.videos.get(clip.video);
    if (!slot) return null;
    const el = slot.el;
    if (el.readyState < 2 || el.seeking) return null;
    // A frame far outside this clip's range (element not seeked yet) must not be shown for the clip.
    const pos = el.currentTime - clip.offset;
    if (pos < -0.5 || pos > clip.duration + 0.5) return null;
    return el;
  }

  private clipsFor(src: string): ClipTL[] {
    return this.tl.clips.filter((c) => c.video === src);
  }

  private sync() {
    const wanted = new Map<string, { isTake: boolean; firstOffset: number }>();
    for (const c of this.tl.clips) {
      if (c.video && !wanted.has(c.video)) wanted.set(c.video, { isTake: c.scene.mode !== 'keep', firstOffset: c.offset });
      this.image(c.still);
    }
    for (const [src, v] of this.videos) {
      if (!wanted.has(src)) {
        v.el.pause();
        v.el.removeAttribute('src');
        v.el.load();
        this.videos.delete(src);
        if (this.activeSrc === src) this.activeSrc = null;
      }
    }
    for (const [src, w] of wanted) {
      if (this.videos.has(src)) continue;
      const el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.playsInline = true;
      el.src = src;
      el.addEventListener('loadedmetadata', () => {
        // Park the element on its first frame of use so the first activation shows the right picture.
        if (!this.playing || this.activeSrc !== src) el.currentTime = w.firstOffset;
        if (w.isTake && Number.isFinite(el.duration) && el.duration > 0) {
          for (const c of this.clipsFor(src)) this.onDuration?.(c.scene.id, Math.round(el.duration * 100) / 100);
        }
      });
      el.load();
      this.videos.set(src, { el, src, isTake: w.isTake });
      if (this.sources.size && this.audioCtx) this.route(el);
    }
    for (const it of this.tl.inserts) this.image(it.insert.image);
    for (const b of this.project.style.board.items) this.image(b.icon);

    const musicUrl = this.project.style.music.url || '';
    if (musicUrl !== this.musicSrc) {
      this.music?.pause();
      this.music = null;
      this.musicSrc = musicUrl;
      if (musicUrl) {
        const a = new Audio();
        a.crossOrigin = 'anonymous';
        a.preload = 'auto';
        a.loop = true;
        a.src = musicUrl;
        this.music = a;
        if (this.sources.size && this.audioCtx) this.route(a);
      }
    }
    if (this.music) this.music.volume = Math.min(1, Math.max(0, this.project.style.music.gain));
  }

  // ---- Transport ----
  play() {
    if (this.playing) return;
    if (this.time >= this.tl.total - 0.01) this.seek(0);
    this.playing = true;
    this.lastNow = performance.now();
    void this.audioCtx?.resume();
    this.notify();
  }

  pause() {
    this.playing = false;
    for (const v of this.videos.values()) v.el.pause();
    this.music?.pause();
    this.notify();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    this.time = Math.min(this.tl.total, Math.max(0, t));
    const clip = clipAt(this.tl, this.time);
    for (const [src, v] of this.videos) {
      if (clip && clip.video === src) {
        const target = clip.offset + Math.max(0, Math.min(clip.duration, this.time - clip.start));
        if (Math.abs(v.el.currentTime - target) > 0.03) v.el.currentTime = target;
        this.activeSrc = src;
        this.activeSceneId = clip.scene.id;
        if (!this.playing) v.el.pause();
      } else {
        v.el.pause();
      }
    }
    if (this.music && Number.isFinite(this.music.duration) && this.music.duration > 0) {
      this.music.currentTime = this.time % this.music.duration;
    }
    this.notify();
  }

  private tick = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    if (!this.playing) return;

    const clip = clipAt(this.tl, this.time);
    const slot = clip?.video ? this.videos.get(clip.video) : null;
    if (clip && slot) {
      const v = slot.el;
      const target = clip.offset + Math.max(0, this.time - clip.start);
      if (this.activeSrc !== slot.src) {
        for (const [src, o] of this.videos) if (src !== slot.src) o.el.pause();
        this.activeSrc = slot.src;
        if (Math.abs(v.currentTime - target) > 0.05) v.currentTime = target;
      } else if (this.activeSceneId !== clip.scene.id) {
        // Same file, next scene: contiguous pieces just keep playing; anything else needs a seek.
        if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
      }
      this.activeSceneId = clip.scene.id;
      if (v.paused && !v.ended) void v.play().catch(() => undefined);
      if (v.ended || v.currentTime >= clip.offset + clip.duration - 0.03) {
        this.time = clip.end + 0.001;
      } else if (v.readyState >= 3 && !v.seeking) {
        this.time = clip.start + (v.currentTime - clip.offset);
      }
    } else {
      if (this.activeSrc) {
        for (const o of this.videos.values()) o.el.pause();
        this.activeSrc = null;
        this.activeSceneId = null;
      }
      this.time += dt;
    }

    if (this.music && this.music.paused) void this.music.play().catch(() => undefined);

    if (this.time >= this.tl.total) {
      this.time = this.tl.total;
      this.pause();
      this.onEnded?.();
      return;
    }
    this.notify();
  };

  private notify() {
    for (const fn of this.listeners) fn();
  }

  draw(ctx: CanvasRenderingContext2D, W: number, H: number, opts?: DrawOptions): FrameLayout {
    return drawFrame(ctx, W, H, this.time, this.project, this.tl, this, opts);
  }

  // ---- Export audio ----
  private route(el: HTMLMediaElement) {
    if (!this.audioCtx || !this.recDest || this.sources.has(el)) return;
    try {
      const src = this.audioCtx.createMediaElementSource(el);
      src.connect(this.audioCtx.destination);
      src.connect(this.recDest);
      this.sources.set(el, src);
    } catch (e) {
      console.warn('audio route failed', e);
    }
  }

  /** Mixes every clip's audio and the music bed into one stream for MediaRecorder (preview stays audible). */
  recordingAudio(): MediaStream {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.recDest = this.audioCtx.createMediaStreamDestination();
      // A silent source keeps the audio track alive even when no clip has audio.
      const silent = this.audioCtx.createConstantSource();
      silent.offset.value = 0;
      silent.connect(this.recDest);
      silent.start();
    }
    void this.audioCtx.resume();
    for (const v of this.videos.values()) this.route(v.el);
    if (this.music) this.route(this.music);
    return this.recDest!.stream;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.pause();
    for (const v of this.videos.values()) {
      v.el.removeAttribute('src');
      v.el.load();
    }
    this.videos.clear();
    void this.audioCtx?.close();
  }
}
