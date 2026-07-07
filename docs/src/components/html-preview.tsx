'use client';

/**
 * Renders a ` ```html preview ` block (base64'd by the remarkHtmlPreview
 * plugin) as a sandboxed, auto-sizing iframe. The iframe gets the same
 * OpenKnowledge theme tokens the editor injects, so one authored block looks
 * identical in the OK editor preview and here on the docs site. Height syncs
 * back over postMessage; theme follows the docs light/dark toggle.
 */

import { useTheme } from 'next-themes';
import { useEffect, useId, useState } from 'react';

const BASE =
  '*{box-sizing:border-box}html,body{margin:0}body{background:transparent;color:var(--foreground);font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5}';

const LIGHT =
  ':root{--background:oklch(1 0 0);--foreground:oklch(0.145 0 0);--card:oklch(1 0 0);--card-foreground:oklch(0.145 0 0);--muted:oklch(0.97 0 0);--muted-foreground:oklch(0.556 0 0);--border:oklch(0.922 0 0);--primary:oklch(0.6321 0.1983 259.59);--accent-soft:#e6efff;--accent-ink:#00245d;--chart-1:oklch(0.62 0.19 259);--chart-2:oklch(0.58 0.14 145);--chart-3:oklch(0.62 0.15 70);--chart-4:oklch(0.55 0.18 290);--chart-5:oklch(0.58 0.21 25);--radius:0.625rem;color-scheme:light}';

const DARK =
  ':root{--background:oklch(0.205 0 0);--foreground:oklch(0.985 0 0);--card:oklch(0.245 0 0);--card-foreground:oklch(0.985 0 0);--muted:oklch(0.3 0 0);--muted-foreground:oklch(0.708 0 0);--border:oklch(1 0 0 / 0.14);--primary:#69a3ff;--accent-soft:#12233f;--accent-ink:#9ec3ff;--chart-1:oklch(0.72 0.14 259);--chart-2:oklch(0.73 0.13 145);--chart-3:oklch(0.77 0.14 70);--chart-4:oklch(0.72 0.16 290);--chart-5:oklch(0.72 0.2 25);--radius:0.625rem;color-scheme:dark}';

function decode(b64: string): string {
  if (typeof atob === 'undefined') return '';
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function HtmlPreview({ code }: { code: string }) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [height, setHeight] = useState(200);
  const domId = useId().replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { __okpreview?: string; h?: number } | null;
      if (d && d.__okpreview === domId && typeof d.h === 'number') {
        setHeight(Math.min(Math.ceil(d.h), 5000));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [domId]);

  if (!mounted) {
    return (
      <div
        className="not-prose my-5 rounded-2xl border border-fd-border bg-fd-card"
        style={{ height }}
      />
    );
  }

  const vars = resolvedTheme === 'dark' ? DARK : LIGHT;
  const inner = decode(code);
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${vars}${BASE}</style></head><body>${inner}<script>(function(){var ID=${JSON.stringify(domId)};function post(){parent.postMessage({__okpreview:ID,h:document.documentElement.scrollHeight},'*')}addEventListener('load',post);addEventListener('resize',post);if(window.ResizeObserver){new ResizeObserver(post).observe(document.body)}var n=0,t=setInterval(function(){post();if(++n>24)clearInterval(t)},250)})()</script></body></html>`;

  return (
    <iframe
      title="Interactive preview"
      sandbox="allow-scripts"
      className="not-prose my-5 w-full rounded-2xl border border-fd-border bg-fd-card shadow-sm"
      style={{ height }}
      srcDoc={srcDoc}
    />
  );
}
