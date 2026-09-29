import type { DesignResult, Voice, VoiceServerInfo } from './types';

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const SERVER_DOWN = 'The server is not responding. Please try again in a moment.';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(SERVER_DOWN, 0, {});
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`, res.status, data);
  return data as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function apiHealth(): Promise<VoiceServerInfo | null> {
  return request<VoiceServerInfo>('/api/voice/health').catch(() => null);
}

export function apiVoices(): Promise<{ presets: Voice[]; mine: Voice[] }> {
  return request('/api/voice/voices');
}

export interface SaveVoiceBody {
  name: string;
  sample: string;
  sampleText: string;
  gender: string | null;
  age: string | null;
  timbre: string[];
  manner: string[];
  description: string;
  source: string;
}

export function apiSaveVoice(body: SaveVoiceBody): Promise<Voice> {
  return post('/api/voice/voices', body);
}

export function apiUpdateVoice(id: string, body: Partial<SaveVoiceBody>): Promise<Voice> {
  return request(`/api/voice/voices/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function apiDeleteVoice(id: string): Promise<{ ok: boolean }> {
  return request(`/api/voice/voices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Makes built-in voice clips: the given voices, or every missing one (`ids` = null). */
export function apiPreparePresets(ids?: string[] | null, force = false): Promise<{ jobId: string | null; count: number; cost: number }> {
  return post('/api/voice/presets/prepare', ids ? { ids, force } : { all: true });
}

export interface JobInfo {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  message: string;
  elapsed: number;
  result?: { ready: number; total: number; failed: string[] };
  error?: string;
}

export function apiJob(id: string): Promise<JobInfo> {
  return request(`/api/voice/job/${encodeURIComponent(id)}`);
}

const EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  // Read through ffmpeg on the server when the browser cannot decode them.
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  wma: 'audio/x-ms-wma',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  amr: 'audio/amr',
  caf: 'audio/x-caf',
};

/**
 * File type for the upload, by extension first: Windows leaves File.type empty for less common extensions or reports
 * aliases the server does not list (video/avi, video/vnd.dlna.mpeg-tts). Recordings and cut clips have no name.
 */
export function mediaType(file: Blob & { name?: string }): string {
  const ext = file.name?.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  return EXT_MIME[ext] || file.type.split(';')[0] || 'application/octet-stream';
}

/** Sends the file as a raw body (no base64) → /media URL. */
export function apiUpload(file: Blob & { name?: string }, prefix: string): Promise<{ url: string; mime: string; bytes: number }> {
  return request(`/api/voice/upload?prefix=${encodeURIComponent(prefix)}`, { method: 'POST', headers: { 'Content-Type': mediaType(file) }, body: file });
}

export function apiExtract(url: string): Promise<{ url: string }> {
  return post('/api/voice/extract', { url });
}

export function apiIsolate(audio: string, seconds: number): Promise<{ url: string; cost: number; mock?: boolean }> {
  return post('/api/voice/isolate', { audio, seconds });
}

export interface TimedPhrase {
  start: number;
  end: number;
  text: string;
}

/** Whisper; with `timestamps` also the timed phrases (twice the price). */
export function apiTranscribe(
  audio: string,
  seconds: number,
  timestamps = false,
): Promise<{ text: string; language?: string; segments?: TimedPhrase[]; cost: number; mock?: boolean }> {
  return post('/api/voice/transcribe', { audio, seconds, timestamps });
}

export interface SpeakBody {
  text: string;
  speed: number;
  voiceId?: string;
  sample?: string;
  sampleText?: string;
}

export function apiSpeak(body: SpeakBody): Promise<{ url: string; cost: number; chars: number; mock?: boolean }> {
  return post('/api/voice/speak', body);
}

export interface DesignBody {
  description: string;
  /** Id of an earlier result for the same description: one more take of that voice. */
  again?: string;
}

export function apiDesign(body: DesignBody): Promise<DesignResult> {
  return post('/api/voice/design', body);
}
