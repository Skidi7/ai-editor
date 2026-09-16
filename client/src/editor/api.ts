import type { ServerInfo } from './types';

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

interface ImageResponse {
  image?: string;
  provider?: string;
  error?: string;
  fallback?: string;
}

function unwrap(r: { status: number; data: ImageResponse }): string {
  if (r.status >= 400 || !r.data.image) throw new Error(r.data.error || `Request failed (${r.status})`);
  return r.data.image;
}

export async function apiHealth(): Promise<ServerInfo | null> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return null;
    return (await res.json()) as ServerInfo;
  } catch {
    return null;
  }
}

export async function apiEdit(input: {
  image: string;
  marked?: string;
  bbox?: [number, number, number, number];
  prompt: string;
  width: number;
  height: number;
}): Promise<string> {
  return unwrap(await postJson<ImageResponse>('/api/edit', input));
}

/** `width`/`height` = target frame size (the model outputs at that aspect ratio). */
export async function apiExpand(input: { image: string; width: number; height: number }): Promise<string> {
  return unwrap(await postJson<ImageResponse>('/api/expand', input));
}

export async function apiReplaceBackground(input: { image: string; prompt: string; width: number; height: number }): Promise<string> {
  return unwrap(await postJson<ImageResponse>('/api/replace-background', input));
}

export interface RelightSettings {
  azimuth: number;
  elevation: number;
  brightness: number;
  color: string;
}

export async function apiRelight(input: { image: string; guide?: string; width: number; height: number; light: RelightSettings }): Promise<string> {
  return unwrap(await postJson<ImageResponse>('/api/relight', input));
}

/** Fetches a remote image through the server (avoids CORS-tainted canvases). */
export async function apiFetchImage(url: string): Promise<string> {
  const res = await fetch(`/api/fetch-image?url=${encodeURIComponent(url)}`);
  const data = (await res.json().catch(() => ({}))) as ImageResponse;
  if (!res.ok || !data.image) throw new Error(data.error || 'Could not load image from URL');
  return data.image;
}

/** Returns the cut-out image, or null when the server asks the browser to do it locally. */
export async function apiRemoveBackground(image: string): Promise<string | null> {
  const r = await postJson<ImageResponse>('/api/remove-background', { image });
  if (r.status === 501) return null;
  return unwrap(r);
}
