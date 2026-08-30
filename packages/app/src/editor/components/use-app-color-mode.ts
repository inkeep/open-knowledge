/**
 * The app's active color mode, for renderers whose output bakes the theme
 * in at draw time (mermaid's themeVariables, Excalidraw's SVG export) and
 * so cannot ride CSS variables the way styled DOM does.
 *
 * Reads the `<html>` class list — the theme provider sets `.dark`/`.light`
 * on `documentElement` (the same contract `useApplyConfigTheme` writes and
 * `useThemeBridge` consumes), so the class is authoritative once the app is
 * up; `prefers-color-scheme` covers only the pre-mount window. The sync
 * runs once BEFORE the observer attaches, closing the window where the
 * provider sets the class between first render and effect commit — the
 * observer only sees post-`observe()` mutations.
 */

import { useEffect, useState } from 'react';

function readDocumentColorMode(): 'light' | 'dark' {
  if (typeof document !== 'undefined') {
    const cls = document.documentElement.classList;
    if (cls.contains('dark')) return 'dark';
    if (cls.contains('light')) return 'light';
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function useAppColorMode(): 'light' | 'dark' {
  const [colorMode, setColorMode] = useState<'light' | 'dark'>(() => readDocumentColorMode());
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => {
      const next = readDocumentColorMode();
      setColorMode((prev) => (prev === next ? prev : next));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return colorMode;
}
