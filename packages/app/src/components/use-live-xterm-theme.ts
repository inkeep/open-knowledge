import type { ITheme } from '@xterm/xterm';
import { useEffect, useState } from 'react';
import { COLOR_THEME_ATTRIBUTE } from '@/lib/use-apply-config-color-theme';
import { computeLiveXtermTheme } from './terminal-theme';

function themesEqual(a: ITheme, b: ITheme): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof ITheme)[]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

export function useLiveXtermTheme(resolvedTheme: string | undefined): ITheme {
  const [theme, setTheme] = useState<ITheme>(() => computeLiveXtermTheme(resolvedTheme));

  useEffect(() => {
    const recompute = () => {
      const next = computeLiveXtermTheme(resolvedTheme);
      setTheme((prev) => (themesEqual(prev, next) ? prev : next));
    };
    recompute();
    let scheduled = 0;
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? () => {
            if (scheduled) return;
            scheduled = requestAnimationFrame(() => {
              scheduled = 0;
              recompute();
            });
          }
        : recompute;
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [COLOR_THEME_ATTRIBUTE, 'class'],
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      if (scheduled) cancelAnimationFrame(scheduled);
      observer.disconnect();
    };
  }, [resolvedTheme]);

  return theme;
}
