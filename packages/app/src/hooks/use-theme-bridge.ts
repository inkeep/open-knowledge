import { useEffect } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/**
 * `rgb(250, 250, 250)` / `rgba(…)` -> `#fafafa`, or null for any other syntax.
 *
 * The `rgb(` prefix check is load-bearing. Matching bare numbers against an
 * arbitrary color string reads `oklch(0.985 0 0)` as the channel triple
 * `0.985, 0, 0` and yields `#010000` — a plausible-looking hex that paints the
 * window chrome near-black. Anything that isn't legacy rgb belongs to
 * `canvasHex` below, and an unrecognized value must be null so the caller falls
 * back to the snapshot rather than painting garbage.
 */
function rgbToHex(value: string): string | null {
  const body = /^rgba?\(([^)]*)\)$/i.exec(value.trim())?.[1];
  if (body === undefined) return null;
  const parts = body.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  let hex = '#';
  for (let i = 0; i < 3; i++) {
    const n = Math.round(Number(parts[i]));
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    hex += n.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Normalize any engine-recognized CSS color to `#rrggbb` through a canvas
 * `fillStyle` round-trip, which is defined to resolve into sRGB.
 *
 * Needed because `getComputedStyle` does NOT convert modern color syntax to
 * legacy rgb: Chromium reports a token authored as `oklch(…)` back as
 * `oklch(…)`, so the probe alone resolves `var()` chains without ever reaching
 * a form Electron can paint with.
 *
 * `fillStyle` silently keeps its previous value when assigned something it
 * can't parse, so a single assignment can't distinguish "converted" from
 * "ignored". Assigning against two different sentinels does: a parsed color
 * lands on the same result both times, an ignored one keeps each sentinel.
 */
function canvasHex(value: string): string | null {
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = value;
  const first = ctx.fillStyle;
  ctx.fillStyle = '#ffffff';
  ctx.fillStyle = value;
  if (ctx.fillStyle !== first) return null;
  return typeof first === 'string' && /^#[0-9a-f]{6}$/i.test(first) ? first.toLowerCase() : null;
}

/**
 * A resolved CSS color as `#rrggbb`, or null when it can't be resolved to one.
 * Exported for the regression tests that pin the `#010000` class above.
 */
export function cssColorToHex(value: string): string | null {
  return canvasHex(value) ?? rgbToHex(value);
}

/**
 * Resolve one design token to a concrete `#rrggbb`.
 *
 * The raw custom property can hold any CSS color syntax — the default theme
 * authors `--sidebar` as `oklch(…)`, and a custom scheme could use
 * `color-mix()`. Electron's `setBackgroundColor` / `titleBarOverlay` accept
 * hex, rgb, hsl or a name, so forwarding the authored text loses the default
 * theme entirely.
 *
 * Two steps, because neither alone suffices: the probe resolves `var()` chains
 * and relative color syntax, and `cssColorToHex` converts whatever color space
 * that lands in down to sRGB hex. `getComputedStyle` does not do the second —
 * Chromium reports an `oklch(…)` token back as `oklch(…)`.
 */
function resolveTokenHex(token: string): string | null {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.backgroundColor = `var(${token})`;
  document.body.appendChild(probe);
  try {
    const resolved = getComputedStyle(probe).backgroundColor;
    // Unset computes to the transparent initial value; an unresolved chain
    // still contains `var(`. Neither is a color main can paint with.
    if (!resolved || resolved === 'rgba(0, 0, 0, 0)' || resolved.includes('var(')) return null;
    return cssColorToHex(resolved);
  } finally {
    probe.remove();
  }
}

/**
 * The active palette's window-chrome colors, read off the live cascade.
 *
 * `--sidebar` is the chrome row's own surface, so it's what the OS-drawn
 * titlebar overlay and the window's solid background should match. Main can't
 * compute this itself — it has no CSS engine, and a user-imported scheme has
 * no build-time representation there at all.
 */
function readChromeColors(): { bg: string; symbol: string } | undefined {
  if (typeof document === 'undefined') return undefined;
  try {
    const bg = resolveTokenHex('--sidebar');
    const symbol = resolveTokenHex('--sidebar-foreground');
    if (!bg || !symbol) return undefined;
    return { bg, symbol };
  } catch {
    return undefined;
  }
}

export function useThemeBridge(
  bridge: OkDesktopBridge | undefined,
  themeValue: string | undefined,
  colorThemeKey?: string,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: colorThemeKey is a signal-only dependency — a palette switch (e.g. Dracula -> Monokai, both dark) must re-run this effect to re-read + re-report chrome even though themeValue is unchanged; it is intentionally not referenced in the body.
  useEffect(() => {
    if (themeValue !== 'light' && themeValue !== 'dark' && themeValue !== 'system') return;
    if (!bridge) return;
    let cancelled = false;
    bridge
      .setThemeSource(themeValue)
      .catch((err: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'theme-source-set-failed',
            themeValue,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      })
      .finally(() => {
        if (cancelled) return;
        const reducedTransparency = window.matchMedia(
          '(prefers-reduced-transparency: reduce)',
        ).matches;
        bridge.signalThemeApplied({ reducedTransparency, chrome: readChromeColors() });
      });
    return () => {
      cancelled = true;
    };
    // `colorThemeKey` participates so a palette switch re-reports chrome —
    // the OS-drawn titlebar tracks the color theme, not just light/dark.
  }, [bridge, themeValue, colorThemeKey]);

  useEffect(() => {
    if (!bridge) return;
    const mql = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const handler = (event: MediaQueryListEvent) => {
      bridge.signalThemeApplied({
        reducedTransparency: event.matches,
        chrome: readChromeColors(),
      });
    };
    mql.addEventListener('change', handler);
    return () => {
      mql.removeEventListener('change', handler);
    };
  }, [bridge]);
}
