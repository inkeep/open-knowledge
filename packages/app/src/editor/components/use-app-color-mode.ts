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
