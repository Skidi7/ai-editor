import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mediaPath, saveBuffer } from './storage.js';

/** ffmpeg is optional: when present, browser WebM exports are re-muxed to MP4 (H.264/AAC). */
let available: boolean | null = null;

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

export async function ffmpegAvailable(): Promise<boolean> {
  if (available !== null) return available;
  available = await new Promise<boolean>((resolve) => {
    try {
      const p = spawn(ffmpegBin(), ['-version']);
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return available;
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
  });
}

/** WebM (VP9/Opus from MediaRecorder) → MP4 (H.264/AAC). Returns the /media URL of the MP4. */
export async function transcodeToMp4(webmUrlOrData: string): Promise<string> {
  if (!(await ffmpegAvailable())) throw new Error('ffmpeg is not available on the server');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vs-'));
  const input = path.join(tmp, 'in.webm');
  const output = path.join(tmp, 'out.mp4');
  try {
    if (webmUrlOrData.startsWith('data:')) {
      const b64 = webmUrlOrData.slice(webmUrlOrData.indexOf(',') + 1);
      await fs.writeFile(input, Buffer.from(b64, 'base64'));
    } else {
      await fs.copyFile(mediaPath(webmUrlOrData), input);
    }
    await run([
      '-y',
      '-i',
      input,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '19',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      output,
    ]);
    const saved = await saveBuffer(await fs.readFile(output), 'video/mp4', 'export');
    return saved.url;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
