import type { Resolution, TakeMode, VideoServerInfo, WordTiming } from './types';

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T & { error?: string; fallback?: string } }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; fallback?: string };
  return { status: res.status, data };
}

function ok<T extends { error?: string }>(r: { status: number; data: T }): T {
  if (r.status >= 400) throw new Error(r.data.error || `Request failed (${r.status})`);
  return r.data;
}

export function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('Could not read file'));
    fr.readAsDataURL(file);
  });
}

export async function apiVideoHealth(): Promise<VideoServerInfo | null> {
  try {
    const res = await fetch('/api/video/health');
    if (!res.ok) return null;
    return (await res.json()) as VideoServerInfo;
  } catch {
    return null;
  }
}

export interface UploadResult {
  url: string;
  mime: string;
  bytes?: number;
  /** MP4 whose boxes declare more data than the file holds: a cut-off download. */
  truncated?: boolean;
  /** Share of the media data that is actually present (0..1) when truncated. */
  presentFraction?: number;
}

/** Stores a local file on the server; returns its /media URL. */
export async function apiUpload(file: File | Blob, prefix: string): Promise<string> {
  return (await apiUploadInfo(file, prefix)).url;
}

export async function apiUploadInfo(file: File | Blob, prefix: string): Promise<UploadResult> {
  // MediaRecorder blobs carry codec parameters in their type ("video/webm;codecs=vp9,opus"); keep the bare media type.
  const clean = file.type.includes(';') ? new Blob([file], { type: file.type.split(';')[0] }) : file;
  const data = await fileToDataUrl(clean);
  return ok(await postJson<UploadResult>('/api/video/upload', { data, prefix }));
}

export async function apiStill(input: { reference: string; outfit: string; pose: string; setting: string; aspect: string }): Promise<{ url: string; prompt: string }> {
  return ok(await postJson<{ url: string; prompt: string }>('/api/video/still', input));
}

export async function apiInsertImage(input: { prompt: string; aspect: string; reference?: string }): Promise<{ url: string }> {
  return ok(await postJson<{ url: string }>('/api/video/image', input));
}

export interface TakeRequest {
  image: string;
  prompt: { dialogue: string; action: string; voice: string; performance: string; gesture: string; editRhythm: string; language: string };
  duration: number;
  resolution: Resolution;
  aspect: string;
  mode: TakeMode;
  voiceSample?: string | null;
}

export async function apiTakeStart(input: TakeRequest): Promise<{ jobId: string; prompt: string; cost: number; mock?: boolean }> {
  return ok(await postJson<{ jobId: string; prompt: string; cost: number; mock?: boolean }>('/api/video/take', input));
}

export interface EditRequest {
  /** /media URL of the trimmed scene clip. */
  video: string;
  /** Character image (/media URL). */
  reference: string;
  duration: number;
  resolution: Resolution;
  notes?: string;
  keepOutfit?: boolean;
}

/** Swap the person inside a clip (Seedance 2.5 video-edit) → job. */
export async function apiEditStart(input: EditRequest): Promise<{ jobId: string; prompt: string; cost: number; mock?: boolean }> {
  return ok(await postJson<{ jobId: string; prompt: string; cost: number; mock?: boolean }>('/api/video/edit', input));
}

export interface JobInfo {
  id: string;
  kind?: string;
  status: 'queued' | 'running' | 'done' | 'error';
  message: string;
  elapsed: number;
  result?: { video: string | null; remoteUrl?: string; duration: number; mock?: boolean };
  error?: string;
}

export async function apiJob(id: string): Promise<JobInfo> {
  const res = await fetch(`/api/video/job/${encodeURIComponent(id)}`);
  const data = (await res.json().catch(() => ({}))) as JobInfo & { error?: string };
  if (!res.ok) throw new Error(data.error || `Job request failed (${res.status})`);
  return data;
}

/** Whisper alignment; returns null when the server cannot do it (mock mode / no timestamps) so the caller estimates. */
export async function apiAlign(input: { video: string; remoteUrl?: string; words: string[]; duration: number; language?: string }): Promise<{
  words: WordTiming[];
  matched: number;
  heard: number;
  granularity?: 'word' | 'segment';
} | null> {
  const r = await postJson<{ words: WordTiming[]; matched: number; heard: number; granularity?: 'word' | 'segment' }>('/api/video/align', input);
  if (r.status === 501 || r.status === 502) return null;
  return ok(r);
}

export interface AnalyzedSegment {
  start: number;
  end: number;
  text: string;
  words?: { word: string; start: number; end: number }[];
}

/** Cuts the source video into speech segments with Whisper; null when the server cannot (mock mode). */
export async function apiAnalyze(input: { video: string; language?: string; duration?: number }): Promise<{
  segments: AnalyzedSegment[];
  granularity: 'word' | 'segment';
} | null> {
  const r = await postJson<{ segments: AnalyzedSegment[]; granularity: 'word' | 'segment' }>('/api/video/analyze', input);
  if (r.status === 501 || r.status === 502) return null;
  return ok(r);
}

/** WebM → MP4 on the server; null when ffmpeg is not installed. */
export async function apiTranscode(webm: Blob): Promise<string | null> {
  const data = await fileToDataUrl(webm);
  const r = await postJson<{ url: string }>('/api/video/transcode', { data });
  if (r.status === 501) return null;
  return ok(r).url;
}
