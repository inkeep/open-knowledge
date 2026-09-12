import { useSyncExternalStore } from 'react';
import { isThemeColorProperty } from './theme-color-properties';
import { themeColorTransitionsActive } from './theme-color-transitions';
import { COLOR_THEME_ATTRIBUTE } from './use-apply-config-color-theme';

let epoch = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let frame = 0;

function notify(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

function scheduleSample(): void {
  if (frame || typeof requestAnimationFrame !== 'function') {
    if (typeof requestAnimationFrame !== 'function') notify();
    return;
  }
  frame = requestAnimationFrame(() => {
    frame = 0;
    notify();
    if (themeColorTransitionsActive()) scheduleSample();
  });
}

function onTransition(event: TransitionEvent): void {
  if (event.target !== document.documentElement) return;
  if (!isThemeColorProperty(event.propertyName)) return;
  scheduleSample();
}

export function subscribeColorThemeEpoch(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof document !== 'undefined') {
    observer = new MutationObserver(scheduleSample);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [COLOR_THEME_ATTRIBUTE, 'class'],
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    document.documentElement.addEventListener('transitionrun', onTransition);
    document.documentElement.addEventListener('transitionend', onTransition);
    document.documentElement.addEventListener('transitioncancel', onTransition);
    if (themeColorTransitionsActive()) scheduleSample();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      document.documentElement.removeEventListener('transitionrun', onTransition);
      document.documentElement.removeEventListener('transitionend', onTransition);
      document.documentElement.removeEventListener('transitioncancel', onTransition);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

function getSnapshot(): number {
  return epoch;
}

function getServerSnapshot(): number {
  return 0;
}

export function useColorThemeEpoch(): number {
  return useSyncExternalStore(subscribeColorThemeEpoch, getSnapshot, getServerSnapshot);
}
