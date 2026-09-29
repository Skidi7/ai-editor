/**
 * WaveSpeed prices for the Voice Studio models (USD), mirrored on the client to label buttons.
 *   OmniVoice TTS / voice-clone: flat $0.005 under 100 characters, then $0.00005 per character.
 *   Qwen3 TTS Voice Design:      $0.005 per 100 characters, proportional (minimum $0.005).
 *   Audio Vocal Isolator:        $0.001 per second of input.
 *   Whisper large-v3:            $0.001 per second, $0.002 with timestamps.
 *   any-llm (description helper): from $0.001 per run.
 */
export const PRICES = {
  omniFlat: 0.005,
  omniPerChar: 0.00005,
  qwenPer100: 0.005,
  isolatePerSecond: 0.001,
  whisperPerSecond: 0.001,
  whisperTimedPerSecond: 0.002,
  llmPerRun: 0.001,
};

const round = (v: number) => Math.round(v * 10000) / 10000;

export function omniPrice(chars: number): number {
  return round(chars < 100 ? PRICES.omniFlat : chars * PRICES.omniPerChar);
}

export function qwenPrice(chars: number): number {
  return round(Math.max(PRICES.qwenPer100, (chars / 100) * PRICES.qwenPer100));
}

export function isolatePrice(seconds: number): number {
  return round(Math.max(1, Math.ceil(seconds)) * PRICES.isolatePerSecond);
}

export function whisperPrice(seconds: number, timestamps = false): number {
  return round(Math.max(1, Math.ceil(seconds)) * (timestamps ? PRICES.whisperTimedPerSecond : PRICES.whisperPerSecond));
}
