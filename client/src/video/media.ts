import fixWebmDuration from 'fix-webm-duration';

/** Browser-side helpers for the source video: metadata, thumbnails for scenes, cutting a piece out as a clip. */

function pickRecorderMime(): string {
  for (const c of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) if (MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

/**
 * Cuts [start, end] of the source video into a WebM clip by playing that range through MediaRecorder
 * (picture from captureStream, sound through Web Audio so muting the element does not silence the clip).
 * The WebM gets a proper duration header, which video services need to accept it.
 */
export async function trimSegment(url: string, start: number, end: number, onProgress?: (msg: string) => void): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder недоступен в этом браузере');
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.preload = 'auto';
  v.playsInline = true;
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(v);
  const ctx = new AudioContext();
  try {
    v.src = url;
    const meta = await new Promise<boolean>((resolve) => {
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
    if (!meta) throw new Error('Не удалось открыть исходное видео');
    const seeked = new Promise<boolean>((resolve) => {
      const t = window.setTimeout(() => resolve(false), 8000);
      v.addEventListener(
        'seeked',
        () => {
          window.clearTimeout(t);
          resolve(true);
        },
        { once: true },
      );
    });
    v.currentTime = start;
    if (!(await seeked)) throw new Error('Не удалось перемотать исходное видео');

    const src = ctx.createMediaElementSource(v);
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    await ctx.resume();
    const stream = new MediaStream();
    const pic = (v as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
    if (!pic) throw new Error('captureStream недоступен в этом браузере');
    for (const t of pic.getVideoTracks()) stream.addTrack(t);
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    const mimeType = pickRecorderMime();
    const rec = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.start(200);
    await v.play();
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (v.ended || v.currentTime >= end - 0.02 || performance.now() - t0 > (end - start + 5) * 1000) return resolve();
        onProgress?.(`Вырезаем фрагмент… ${Math.round(((v.currentTime - start) / Math.max(0.1, end - start)) * 100)}%`);
        window.setTimeout(check, 40);
      };
      check();
    });
    v.pause();
    rec.stop();
    await stopped;
    for (const t of stream.getTracks()) t.stop();
    const raw = new Blob(chunks, { type: mimeType || 'video/webm' });
    if (!raw.size) throw new Error('Фрагмент не записался (пустой файл)');
    return await fixWebmDuration(raw, Math.round((end - start) * 1000), { logger: false });
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
    void ctx.close();
  }
}

export function probeVideo(url: string): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const timer = window.setTimeout(() => reject(new Error('Видео не открылось за 20 секунд (формат не поддерживается браузером?)')), 20000);
    const finish = () => {
      window.clearTimeout(timer);
      resolve({ duration: Number.isFinite(v.duration) ? v.duration : 0, width: v.videoWidth, height: v.videoHeight });
      v.removeAttribute('src');
      v.load();
    };
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) {
        finish();
        return;
      }
      // WebM from MediaRecorder / screen recorders has no duration header: seeking to the end reveals it.
      const t2 = window.setTimeout(finish, 8000);
      v.ondurationchange = () => {
        if (Number.isFinite(v.duration)) {
          window.clearTimeout(t2);
          finish();
        }
      };
      v.currentTime = 1e101;
    };
    v.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('Не удалось прочитать видео (формат не поддерживается браузером?)'));
    };
    v.src = url;
  });
}

function once(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
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
 * Grabs one small JPEG frame per time (seconds). Same-origin /media URLs only (canvas must stay untainted).
 * Never hangs: every wait has a timeout, and a frame that cannot be decoded in time yields null.
 */
export async function extractThumbs(url: string, times: number[], maxW = 180): Promise<(string | null)[]> {
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.crossOrigin = 'anonymous';
  v.src = url;
  const meta = once(v, 'loadedmetadata', 15000);
  v.load();
  if (!(await meta) || !v.videoWidth) {
    v.removeAttribute('src');
    v.load();
    return times.map(() => null);
  }
  const k = Math.min(1, maxW / Math.max(1, v.videoWidth));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(v.videoWidth * k));
  c.height = Math.max(1, Math.round(v.videoHeight * k));
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  const out: (string | null)[] = [];
  for (const t of times) {
    const target = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.05));
    const seeked = once(v, 'seeked', 5000);
    v.currentTime = target;
    const ok = await seeked;
    if (!ok && v.readyState < 2) {
      out.push(null);
      continue;
    }
    try {
      ctx.drawImage(v, 0, 0, c.width, c.height);
      out.push(c.toDataURL('image/jpeg', 0.7));
    } catch {
      out.push(null);
    }
  }
  v.removeAttribute('src');
  v.load();
  return out;
}
