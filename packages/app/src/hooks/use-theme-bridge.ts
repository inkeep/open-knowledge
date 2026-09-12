import { useEffect } from 'react';
import { subscribeColorThemeEpoch } from '@/lib/color-theme-epoch';
import { cssColorToHex } from '@/lib/css-color-to-hex';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { themeColorTransitionsActive } from '@/lib/theme-color-transitions';

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: colorThemeKey requests a fresh settled report for same-mode palette changes
  useEffect(() => {
    if (themeValue !== 'light' && themeValue !== 'dark' && themeValue !== 'system') return;
    if (!bridge) return;
    let cancelled = false;
    let applied = false;
    let reported: string | undefined;
    const mql = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const signalSettledTheme = () => {
      if (cancelled || !applied || themeColorTransitionsActive()) return;
      const payload = {
        reducedTransparency: mql.matches,
        chrome: readChromeColors(),
      };
      const signature = JSON.stringify(payload);
      if (signature === reported) return;
      bridge.signalThemeApplied(payload);
      reported = signature;
    };
    const unsubscribe = subscribeColorThemeEpoch(signalSettledTheme);
    mql.addEventListener('change', signalSettledTheme);
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
        applied = true;
        signalSettledTheme();
      });
    return () => {
      cancelled = true;
      unsubscribe();
      mql.removeEventListener('change', signalSettledTheme);
    };
  }, [bridge, colorThemeKey, themeValue]);
}
