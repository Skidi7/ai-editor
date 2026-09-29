import { useSyncExternalStore } from 'react';

/**
 * One shared <audio> for every round play button (voice samples, design variants): starting one sound stops the
 * previous one, and starting any other <audio> on the page (history players) stops it too.
 */

let audio: HTMLAudioElement | null = null;
let current: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.onended = () => {
    current = null;
    emit();
  };
  audio.onerror = () => {
    current = null;
    emit();
  };
  // Any other player on the page starting → stop ours.
  document.addEventListener(
    'play',
    (e) => {
      if (e.target !== audio && current) stopPlayback();
    },
    true,
  );
  return audio;
}

export function stopPlayback() {
  if (audio && !audio.paused) audio.pause();
  if (current) {
    current = null;
    emit();
  }
}

export function togglePlay(url: string) {
  const a = element();
  if (current === url) {
    stopPlayback();
    return;
  }
  for (const other of Array.from(document.querySelectorAll('audio'))) if (!other.paused) other.pause();
  a.src = url;
  current = url;
  emit();
  void a.play().catch(() => {
    if (current === url) {
      current = null;
      emit();
    }
  });
}

export function usePlaying(url: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => !!url && current === url);
}
