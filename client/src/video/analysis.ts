/**
 * Local (in-browser) analysis of the source video, no network needed. The video is played hidden at 3× speed
 * through the browser's normal playback pipeline (which decodes everything the browser can play):
 *  - speech pauses come from the loudness envelope read off a Web Audio analyser,
 *  - shot changes from frame-to-frame luminance difference in a 48-px-wide canvas,
 *  - the point where playback stops advancing tells how much of the file is actually playable.
 * A boundary builder then turns pauses / cuts / Whisper phrase ends into scenes.
 */

export interface Interval {
  start: number;
  end: number;
}

export interface Candidate {
  /** Seconds into the source. */
  time: number;
  /** 0..1, how confident we are this is a good place to cut. */
  strength: number;
  kind: 'pause' | 'cut' | 'phrase';
}

export interface PlaybackAnalysis {
  pauses: Interval[];
  cuts: number[];
  /** Media time where playback stopped (≈ duration for a healthy file). */
  playableEnd: number;
  audioOk: boolean;
  videoOk: boolean;
}

const RATE = 3;

/** Speech pauses from loudness samples (t = media seconds, level = RMS): quiet runs at least `minPause` long. */
export function pausesFromEnvelope(samples: { t: number; level: number }[], minPause = 0.3): Interval[] {
  if (samples.length < 20) return [];
  const levels = samples.map((s) => s.level).sort((a, b) => a - b);
  const q = (p: number) => levels[Math.min(levels.length - 1, Math.floor(p * levels.length))] ?? 0;
  const floor = q(0.1);
  const speech = q(0.85);
  if (speech - floor < 0.004) return []; // flat envelope (music bed / silence only): no usable pauses
  const threshold = floor + (speech - floor) * 0.22;
  const pauses: Interval[] = [];
  let runStart = -1;
  let last = samples[samples.length - 1].t;
  for (let i = 0; i <= samples.length; i++) {
    const s = samples[i];
    const quiet = !!s && s.level < threshold;
    if (quiet && runStart < 0) runStart = s.t;
    if (!quiet && runStart >= 0) {
      const end = s ? s.t : last;
      if (end - runStart >= minPause) pauses.push({ start: runStart, end });
      runStart = -1;
    }
  }
  return pauses;
}

/** Threshold above which a frame difference counts as a shot change (relative to the typical difference). */
export function cutThreshold(diffs: { t: number; d: number }[]): number {
  const ds = diffs.map((x) => x.d).sort((a, b) => a - b);
  const median = ds[Math.floor(ds.length / 2)] ?? 0;
  return Math.max(0.12, median * 4 + 0.04);
}

/** Shot changes from frame differences (t, d in 0..1): spikes well above the typical difference. */
export function cutsFromDiffs(diffs: { t: number; d: number }[]): number[] {
  if (diffs.length < 5) return [];
  const thr = cutThreshold(diffs);
  const cuts: number[] = [];
  for (const { t, d } of diffs) {
    if (d < thr) continue;
    if (cuts.length && t - cuts[cuts.length - 1] < 0.5) continue;
    cuts.push(Math.round(t * 100) / 100);
  }
  return cuts;
}

export async function analyzePlayback(url: string, onProgress?: (msg: string) => void): Promise<PlaybackAnalysis> {
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  // Kept inside the viewport (tiny, almost transparent): off-screen media may not get decoded frames in some browsers.
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(v);
  v.src = url;
  const result: PlaybackAnalysis = { pauses: [], cuts: [], playableEnd: 0, audioOk: false, videoOk: false };
  let audioCtx: AudioContext | null = null;
  try {
    const ready = await new Promise<boolean>((resolve) => {
      const t = window.setTimeout(() => resolve(false), 15000);
      v.onloadedmetadata = () => {
        window.clearTimeout(t);
        resolve(true);
      };
      v.onerror = () => {
        window.clearTimeout(t);
        resolve(false);
      };
    });
    if (!ready) return result;
    // Unknown duration (MediaRecorder WebM): play to the end and take the last time as the duration.
    const duration = Number.isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER;

    // Audio through an analyser, silenced by a zero gain (the element itself must stay unmuted).
    let analyser: AnalyserNode | null = null;
    try {
      audioCtx = new AudioContext();
      const src = audioCtx.createMediaElementSource(v);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      src.connect(analyser);
      analyser.connect(gain);
      gain.connect(audioCtx.destination);
      await audioCtx.resume();
    } catch {
      analyser = null;
      v.muted = true;
    }

    // Video into a tiny canvas.
    const w = 48;
    const h = v.videoWidth ? Math.max(8, Math.round((v.videoHeight / v.videoWidth) * w)) : 27;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });

    v.playbackRate = RATE;
    try {
      await v.play();
    } catch {
      // Autoplay with sound refused: retry muted (cuts only).
      v.muted = true;
      analyser = null;
      try {
        await v.play();
      } catch {
        return result;
      }
    }

    const env: { t: number; level: number }[] = [];
    const diffs: { t: number; d: number }[] = [];
    const buf = analyser ? new Float32Array(analyser.fftSize) : null;
    let prev: Float32Array | null = null;
    let lastFrameT = -1;
    let lastProgressT = 0;
    let stalledSince = performance.now();
    let lastMsg = 0;

    await new Promise<void>((resolve) => {
      const step = () => {
        const t = v.currentTime;
        if (v.ended || t >= duration - 0.05) {
          lastProgressT = Math.max(lastProgressT, Math.min(t, duration));
          return resolve();
        }
        if (t > lastProgressT + 0.01) {
          lastProgressT = t;
          stalledSince = performance.now();
        } else if (performance.now() - stalledSince > 6000) {
          return resolve(); // no more decodable data (cut-off file or unsupported codec)
        }
        if (analyser && buf && v.readyState >= 2) {
          analyser.getFloatTimeDomainData(buf);
          let s = 0;
          for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
          env.push({ t, level: Math.sqrt(s / buf.length) });
        }
        if (ctx && v.videoWidth && v.readyState >= 2 && t - lastFrameT >= 0.1) {
          lastFrameT = t;
          ctx.drawImage(v, 0, 0, w, h);
          const px = ctx.getImageData(0, 0, w, h).data;
          // Keep all three channels: a cut between two colours of similar brightness must still register.
          const cur = new Float32Array(w * h * 3);
          for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
            cur[j] = px[i];
            cur[j + 1] = px[i + 1];
            cur[j + 2] = px[i + 2];
          }
          if (prev) {
            let s = 0;
            for (let i = 0; i < cur.length; i++) s += Math.abs(cur[i] - prev[i]);
            diffs.push({ t, d: s / cur.length / 255 });
          }
          prev = cur;
        }
        if (onProgress && performance.now() - lastMsg > 500) {
          lastMsg = performance.now();
          onProgress(duration < 1e9 ? `Смотрим и слушаем видео… ${Math.round((Math.min(t, duration) / duration) * 100)}%` : `Смотрим и слушаем видео… ${Math.round(t)} с`);
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    v.pause();
    result.playableEnd = Math.round(Math.min(duration, Math.max(lastProgressT, v.currentTime)) * 100) / 100;
    result.audioOk = env.length > 20;
    result.videoOk = diffs.length > 3;
    result.pauses = pausesFromEnvelope(env);
    result.cuts = cutsFromDiffs(diffs);
    return result;
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
    if (audioCtx) void audioCtx.close();
  }
}

// ---------- Tab-independent path: decoded audio + frame stepping ----------

/** Loudness envelope from fully decoded audio (works while the tab is in the background). */
export async function decodeEnvelope(url: string): Promise<{ samples: { t: number; level: number }[]; duration: number } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  let audio: AudioBuffer;
  try {
    // OfflineAudioContext decodes without needing user activation or an unmuted output.
    audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
  } catch {
    return null;
  }
  const sr = audio.sampleRate;
  const hop = Math.max(1, Math.round(sr * 0.02));
  const frames = Math.floor(audio.length / hop);
  const chans = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const samples: { t: number; level: number }[] = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const off = f * hop;
    for (let i = 0; i < hop; i++) {
      let s = 0;
      for (const ch of chans) s += ch[off + i];
      s /= chans.length;
      sum += s * s;
    }
    samples.push({ t: f * 0.02, level: Math.sqrt(sum / hop) });
  }
  return { samples, duration: audio.duration };
}

function waitEvent(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener(event, done);
      window.clearTimeout(timer);
      resolve(true);
    };
    const timer = window.setTimeout(() => {
      el.removeEventListener(event, done);
      resolve(false);
    }, timeoutMs);
    el.addEventListener(event, done);
  });
}

/**
 * Frame differences by seeking through the file step by step (no real-time playback, so no dependence on rAF).
 * Detected shot changes are then refined with finer seeks so a boundary lands on the first frame of the new shot.
 */
export async function stepFrames(
  url: string,
  onProgress?: (msg: string) => void,
): Promise<{ diffs: { t: number; d: number }[]; cuts: number[]; playableEnd: number; duration: number; ok: boolean }> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(v);
  const out = { diffs: [] as { t: number; d: number }[], cuts: [] as number[], playableEnd: 0, duration: 0, ok: false };
  try {
    v.src = url;
    if (!(await waitEvent(v, 'loadedmetadata', 15000))) return out;
    if (!Number.isFinite(v.duration)) {
      const dc = waitEvent(v, 'durationchange', 8000);
      v.currentTime = 1e101;
      await dc;
    }
    if (!Number.isFinite(v.duration) || !v.videoWidth) return out;
    const duration = v.duration;
    out.duration = duration;
    const w = 48;
    const h = Math.max(8, Math.round((v.videoHeight / v.videoWidth) * w));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return out;
    const step = Math.min(0.5, Math.max(0.15, duration / 600));
    const grab = async (t: number): Promise<Float32Array | null> => {
      const seeked = waitEvent(v, 'seeked', 2500);
      v.currentTime = t;
      if (!(await seeked) || v.readyState < 2) return null;
      ctx.drawImage(v, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      const cur = new Float32Array(w * h * 3);
      for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
        cur[j] = px[i];
        cur[j + 1] = px[i + 1];
        cur[j + 2] = px[i + 2];
      }
      return cur;
    };
    const diff = (a: Float32Array, b: Float32Array) => {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
      return s / a.length / 255;
    };
    let prev: Float32Array | null = null;
    let fails = 0;
    let lastOk = 0;
    let lastMsg = 0;
    for (let t = 0; t < duration - 0.02; t += step) {
      const cur = await grab(t);
      if (!cur) {
        fails++;
        if (fails >= 3) break; // no more decodable data (cut-off file) or seeking unsupported
        continue;
      }
      fails = 0;
      lastOk = t;
      if (prev) out.diffs.push({ t, d: diff(cur, prev) });
      prev = cur;
      if (onProgress && performance.now() - lastMsg > 400) {
        lastMsg = performance.now();
        onProgress(`Просматриваем кадры… ${Math.round((t / duration) * 100)}%`);
      }
    }
    out.playableEnd = fails >= 3 ? Math.round((lastOk + step) * 100) / 100 : duration;
    out.ok = out.diffs.length >= 5;
    // Refine each coarse cut (found between t-step and t) with finer seeks: the boundary is the first changed frame.
    const coarse = cutsFromDiffs(out.diffs);
    const thr = cutThreshold(out.diffs);
    const fine = Math.max(0.02, step / 6);
    for (let i = 0; i < coarse.length; i++) {
      onProgress?.(`Уточняем смены кадра… ${i + 1}/${coarse.length}`);
      const t1 = coarse[i];
      const t0 = Math.max(0, t1 - step);
      let last = await grab(t0);
      let found = t1;
      if (last) {
        for (let t = t0 + fine; t <= t1 + 0.001; t += fine) {
          const cur = await grab(Math.min(t, t1));
          if (!cur) break;
          if (diff(cur, last) >= thr * 0.6) {
            found = Math.min(t, t1);
            break;
          }
          last = cur;
        }
      }
      // Put the boundary just before the first frame of the new shot so that frame belongs to the next scene.
      out.cuts.push(Math.round(Math.max(0, found - 0.01) * 100) / 100);
    }
    return out;
  } finally {
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
}

/**
 * Full analysis of the source: decoded audio for pauses, frame stepping for cuts. Neither depends on the tab
 * being visible. Real-time playback (`analyzePlayback`) is only the fallback when one of them cannot work.
 */
export async function analyzeSourceMedia(url: string, onProgress?: (msg: string) => void): Promise<PlaybackAnalysis> {
  onProgress?.('Слушаем звук…');
  const env = await decodeEnvelope(url).catch(() => null);
  const frames = await stepFrames(url, onProgress).catch(() => ({ diffs: [] as { t: number; d: number }[], cuts: [] as number[], playableEnd: 0, duration: 0, ok: false }));
  const knownDuration = frames.duration || env?.duration || 0;
  // Decoded audio much shorter than the video means a damaged file: don't trust it, let playback decide.
  const audioTrusted = !!env && env.samples.length > 20 && (!knownDuration || env.duration >= knownDuration * 0.8);
  let pauses = audioTrusted ? pausesFromEnvelope(env!.samples) : null;
  let cuts = frames.ok ? frames.cuts : null;
  let playableEnd = frames.ok ? frames.playableEnd : 0;
  if (pauses === null || cuts === null) {
    onProgress?.('Смотрим и слушаем видео…');
    const pb = await analyzePlayback(url, onProgress);
    if (pauses === null) pauses = pb.pauses;
    if (cuts === null) cuts = pb.cuts;
    if (!frames.ok) playableEnd = pb.playableEnd;
  }
  return { pauses, cuts, playableEnd, audioOk: audioTrusted, videoOk: frames.ok };
}

/** Turns pauses / cuts / phrase ends into cut candidates. */
export function candidatesFrom(pauses: Interval[], cuts: number[], phraseEnds: number[] = []): Candidate[] {
  const out: Candidate[] = [];
  for (const p of pauses) {
    const len = p.end - p.start;
    // Cut just before the next phrase starts so the previous scene keeps its natural tail.
    out.push({ time: Math.max(p.start + 0.05, p.end - 0.12), strength: Math.min(0.9, 0.3 + len * 0.6), kind: 'pause' });
  }
  for (const c of cuts) out.push({ time: c, strength: 1, kind: 'cut' });
  for (const e of phraseEnds) out.push({ time: e, strength: 0.75, kind: 'phrase' });
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Chooses boundaries. Shot changes are hard boundaries (a shot may be short: the person in frame changes there).
 * Pauses / phrase ends are added only where they keep every scene at least `minLen` long. Scenes longer than
 * `maxLen` are split at the best weaker candidate inside them, or evenly.
 */
export function buildSegments(duration: number, candidates: Candidate[], minLen = 1.5, maxLen = 30, targetLen = 10): Interval[] {
  const MIN_SHOT = 0.3;
  // A shot longer than this gets split at its best pause, so replaced pieces stay manageable.
  const LONG_SHOT = 20;
  let bounds: number[] = [];
  const cuts = candidates.filter((c) => c.kind === 'cut' && c.time > MIN_SHOT && c.time < duration - MIN_SHOT).map((c) => c.time);
  for (const t of cuts) if (!bounds.length || t - bounds[bounds.length - 1] >= MIN_SHOT) bounds.push(t);
  const soft = candidates.filter((c) => c.kind !== 'cut' && c.strength >= 0.45 && c.time > minLen && c.time < duration - minLen).sort((a, b) => b.strength - a.strength);
  if (!cuts.length) {
    // No shot changes at all (one continuous take): phrases are the only sensible scenes.
    for (const c of soft) if (bounds.every((b) => Math.abs(b - c.time) >= minLen)) bounds.push(c.time);
  }
  bounds.sort((a, b) => a - b);
  if (cuts.length) maxLen = Math.min(maxLen, LONG_SHOT);
  const boundStrength: number[] = [];
  const refine = (a: number, b: number): number[] => {
    if (b - a <= maxLen) return [];
    const inside = candidates.filter((c) => c.time > a + minLen && c.time < b - minLen);
    let cut: number;
    if (inside.length) {
      const mid = (a + b) / 2;
      const scored = inside.map((c) => ({ t: c.time, s: c.strength - Math.abs(c.time - mid) / (b - a) }));
      scored.sort((x, y) => y.s - x.s);
      cut = scored[0].t;
    } else cut = a + Math.min(maxLen, targetLen);
    return [...refine(a, cut), cut, ...refine(cut, b)];
  };
  const all = [0, ...bounds, duration];
  const extra: number[] = [];
  for (let i = 0; i < all.length - 1; i++) extra.push(...refine(all[i], all[i + 1]));
  bounds = [...bounds, ...extra].sort((a, b) => a - b);
  void boundStrength;
  const segs: Interval[] = [];
  let start = 0;
  for (const b of bounds) {
    if (b - start >= MIN_SHOT) {
      segs.push({ start, end: b });
      start = b;
    }
  }
  if (duration - start >= MIN_SHOT || !segs.length) segs.push({ start, end: duration });
  else segs[segs.length - 1].end = duration;
  return segs.map((s) => ({ start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100 }));
}
