import type { ITheme } from '@xterm/xterm';
import { useEffect, useState } from 'react';
import { COLOR_THEME_ATTRIBUTE } from '@/lib/use-apply-config-color-theme';
import { computeLiveXtermTheme } from './terminal-theme';

function themesEqual(a: ITheme, b: ITheme): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof ITheme)[]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * The xterm palette for the current app theme, kept live across BOTH theme
 * axes: light/dark mode (`resolvedTheme`) and the color-theme layer
 * (`data-color-theme` attribute + the runtime custom-palette `<style>` in
 * `<head>`). The mode axis arrives via the prop; the color-theme axis has no
 * React signal — it lands as DOM mutations from `useApplyConfigColorTheme` —
 * so a MutationObserver recomputes on those. Identity is stable across
 * recomputes that resolve to the same colors, so consumers can hang effects
 * off the returned object.
 */
export function useLiveXtermTheme(resolvedTheme: string | undefined): ITheme {
  const [theme, setTheme] = useState<ITheme>(() => computeLiveXtermTheme(resolvedTheme));

  useEffect(() => {
    const recompute = () => {
      const next = computeLiveXtermTheme(resolvedTheme);
      setTheme((prev) => (themesEqual(prev, next) ? prev : next));
    };
    // The mount/prop-change recompute also covers the first client render
    // (initial state may have computed before the FOUC script's tokens won).
    recompute();
    const observer = new MutationObserver(recompute);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [COLOR_THEME_ATTRIBUTE, 'class'],
    });
    // The custom theme's palette lives in a <style> tag upserted into <head>;
    // watch its insertion/removal and text swaps.
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [resolvedTheme]);

  return theme;
}
