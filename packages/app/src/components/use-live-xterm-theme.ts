import type { ITheme } from '@xterm/xterm';
import { useEffect, useState } from 'react';
import { useColorThemeEpoch } from '@/lib/color-theme-epoch';
import { computeLiveXtermTheme, liveTokenReaderForEpoch } from './terminal-theme';

function themesEqual(a: ITheme, b: ITheme): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof ITheme)[]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

export function useLiveXtermTheme(resolvedTheme: string | undefined): ITheme {
  const epoch = useColorThemeEpoch();
  const [theme, setTheme] = useState<ITheme>(() =>
    computeLiveXtermTheme(resolvedTheme, liveTokenReaderForEpoch(epoch)),
  );

  useEffect(() => {
    const next = computeLiveXtermTheme(resolvedTheme, liveTokenReaderForEpoch(epoch));
    setTheme((prev) => (themesEqual(prev, next) ? prev : next));
  }, [epoch, resolvedTheme]);

  return theme;
}
