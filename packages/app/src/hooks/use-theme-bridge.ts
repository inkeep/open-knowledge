import { useEffect } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

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

export function cssColorToHex(value: string): string | null {
  return canvasHex(value) ?? rgbToHex(value);
}

function resolveTokenHex(token: string): string | null {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.backgroundColor = `var(${token})`;
  document.body.appendChild(probe);
  try {
    const resolved = getComputedStyle(probe).backgroundColor;
    if (!resolved || resolved === 'rgba(0, 0, 0, 0)' || resolved.includes('var(')) return null;
    return cssColorToHex(resolved);
  } finally {
    probe.remove();
  }
}

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
