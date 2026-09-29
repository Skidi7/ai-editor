import type { Player } from './player';

/**
 * Records the composition in real time: the same drawFrame that feeds the preview draws into an offscreen canvas
 * whose captureStream (+ the mixed audio) goes to MediaRecorder. Output is WebM; the server can re-mux to MP4
 * when ffmpeg is available.
 */
export interface ExportOptions {
  fps?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

function pickMime(): string {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const c of candidates) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function exportVideo(player: Player, W: number, H: number, opts: ExportOptions = {}): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not supported in this browser');
  const fps = opts.fps ?? 30;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  // Chrome only delivers captureStream frames for a canvas that is in the document, so park it off-screen.
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    throw new Error('2D context unavailable');
  }

  player.pause();
  const stream = canvas.captureStream(fps);
  const audio = player.recordingAudio();
  for (const track of audio.getAudioTracks()) stream.addTrack(track);
  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: W * H >= 1080 * 1920 ? 18_000_000 : 10_000_000,
    audioBitsPerSecond: 192_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  player.seek(0);
  await wait(250);
  player.draw(ctx, W, H);

  const ended = new Promise<void>((resolve) => {
    const prev = player.onEnded;
    player.onEnded = () => {
      prev?.();
      player.onEnded = prev;
      resolve();
    };
  });

  recorder.start(250);
  player.play();
  let raf = 0;
  let done = false;
  const loop = () => {
    if (done) return;
    player.draw(ctx, W, H);
    opts.onProgress?.(player.tl.total ? player.time / player.tl.total : 1);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  const aborted = new Promise<never>((_, reject) => {
    opts.signal?.addEventListener('abort', () => reject(new Error('Export cancelled')), { once: true });
  });
  try {
    await Promise.race([ended, aborted]);
  } catch (e) {
    canvas.remove();
    recorder.stop();
    throw e;
  } finally {
    done = true;
    cancelAnimationFrame(raf);
  }
  player.draw(ctx, W, H);
  await wait(200);
  recorder.stop();
  await stopped;
  for (const track of stream.getVideoTracks()) track.stop();
  canvas.remove();
  opts.onProgress?.(1);
  const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
  if (!blob.size) throw new Error('The browser produced an empty recording. Keep the tab visible during export and try again.');
  return blob;
}
