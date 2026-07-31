/**
 * A counter that bumps whenever the active color theme changes.
 *
 * The light/dark axis reaches React through `next-themes`, but the color-theme
 * axis has no React signal — `useApplyConfigColorTheme` lands it as DOM
 * mutations (the `data-color-theme` attribute, plus the runtime `<style>` a
 * custom scheme injects into `<head>`). Components that must recompute on a
 * palette switch subscribe here.
 *
 * One `MutationObserver` backs every subscriber, not one per component. The
 * consumers are per-instance and unbounded — a document can hold many preview
 * blocks — and a DOM observer is not a React effect, so a per-instance
 * observer would scale with content rather than with the single thing being
 * watched.
 */

import { useSyncExternalStore } from 'react';
import { COLOR_THEME_ATTRIBUTE } from './use-apply-config-color-theme';

let epoch = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function notify(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof document !== 'undefined') {
    observer = new MutationObserver(notify);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [COLOR_THEME_ATTRIBUTE, 'class'],
    });
    // A custom scheme's palette lives in a <style> upserted into <head>; watch
    // its insertion, removal, and text swaps so live edits register too.
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

function getSnapshot(): number {
  return epoch;
}

/** Server snapshot — no DOM to observe, so the epoch never advances. */
function getServerSnapshot(): number {
  return 0;
}

export function useColorThemeEpoch(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
