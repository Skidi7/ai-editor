import type { Resolution } from './geometry';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Service messages in plain Russian where we know what they mean. */
export function friendly(msg: string): string {
  if (/sensitive|nsfw|content (policy|moderation)|safety|inappropriate|violat/i.test(msg)) {
    return 'Сервис отклонил фото фильтром содержимого. Попробуйте другое фото.';
  }
  if (/insufficient|balance|credit/i.test(msg)) return 'На счёте WaveSpeed не хватает средств.';
  if (/UND_ERR_CONNECT|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return 'Нет связи с WaveSpeed (сеть или VPN). Деньги не списаны — попробуйте ещё раз.';
  }
  if (/lora/i.test(msg)) return `Модель не смогла загрузить LoRA: ${msg}`;
  if (/timed out|timeout/i.test(msg)) return 'Генерация не уложилась по времени. Попробуйте ещё раз.';
  return msg;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('Сервер не отвечает. Попробуйте ещё раз через минуту.', 0);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(friendly(typeof data.error === 'string' ? data.error : `Ошибка запроса (${res.status})`), res.status);
  return data as T;
}

export interface FaceSwapInfo {
  provider: 'wavespeed' | 'mock';
  model: string;
  lora: string;
  prices: Record<Resolution, number>;
  /** Body Swap reference normalisation (plain Qwen 2.1, 1K). */
  normalizePrice?: number;
  /** Prices with a third picture (Body Swap of two people). */
  pricesTwo?: Record<Resolution, number>;
  /** daily: null = no limit */
  budget: { daily: number | null; spentToday: number };
}

export function apiHealth(): Promise<FaceSwapInfo | null> {
  return request<FaceSwapInfo>('/api/faceswap/health').catch(() => null);
}

export interface RunBody {
  /** head = BFS Head Swap V1.1, body = BFS Body Swap V1.0 (the whole person). */
  mode: 'head' | 'body';
  target: string;
  head: string;
  /** Body Swap of a couple: the person for the right one (picture 3). */
  head2?: string;
  resolution: Resolution;
  aspect: string;
  variants: number;
  seed?: number;
  strength: number;
  tokens: 'image' | 'picture';
  version: 'v1.1' | 'v1.1-alt' | 'v1';
  extra?: string;
}

export interface RunResponse {
  results: Array<{ seed: number; url?: string; error?: string; paid?: boolean }>;
  cost: number;
  each: number;
  prompt: string;
  mock?: boolean;
}

/** The author's optional Body Swap step: the person as a full-body, front-facing reference (a separate generation). */
export function apiNormalize(body: { person: string; tokens: 'image' | 'picture' }): Promise<{ url: string; cost: number; mock?: boolean }> {
  return request('/api/faceswap/normalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function apiRun(body: RunBody): Promise<RunResponse> {
  return request('/api/faceswap/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
