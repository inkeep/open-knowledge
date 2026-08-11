'use client';

/**
 * Renders a ` ```html preview ` block (base64'd by the remarkHtmlPreview
 * plugin) as a sandboxed, auto-sizing iframe. The iframe gets the same
 * OpenKnowledge theme tokens the editor injects, so one authored block looks
 * identical in the OK editor preview and here on the docs site.
 *
 * The document carries BOTH palettes and picks between them itself, which keeps
 * `srcDoc` a pure function of the authored code. That matters twice over: the
 * iframe can be rendered before the docs theme is known (so no empty card
 * precedes it, and measuring starts as the page is parsed), and switching the
 * docs theme no longer rewrites `srcDoc` and reloads every preview on the page.
 */

import { useTheme } from 'next-themes';
import { useEffect, useId, useRef, useState } from 'react';
import {
  DEFAULT_PREVIEW_RESERVE_PX,
  MAX_PREVIEW_HEIGHT_PX,
  recallPreviewHeight,
  rememberPreviewHeight,
  restorePreviewHeights,
} from './preview-height-memory';

const BASE =
  '*{box-sizing:border-box}html,body{margin:0}body{background:transparent;color:var(--foreground);font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5}';

const LIGHT =
  '--background:oklch(1 0 0);--foreground:oklch(0.145 0 0);--card:oklch(1 0 0);--card-foreground:oklch(0.145 0 0);--muted:oklch(0.97 0 0);--muted-foreground:oklch(0.556 0 0);--border:oklch(0.922 0 0);--primary:oklch(0.6321 0.1983 259.59);--accent-soft:#e6efff;--accent-ink:#00245d;--chart-1:oklch(0.62 0.19 259);--chart-2:oklch(0.58 0.14 145);--chart-3:oklch(0.62 0.15 70);--chart-4:oklch(0.55 0.18 290);--chart-5:oklch(0.58 0.21 25);--radius:0.625rem;color-scheme:light';

const DARK =
  '--background:oklch(0.205 0 0);--foreground:oklch(0.985 0 0);--card:oklch(0.245 0 0);--card-foreground:oklch(0.985 0 0);--muted:oklch(0.3 0 0);--muted-foreground:oklch(0.708 0 0);--border:oklch(1 0 0 / 0.14);--primary:#69a3ff;--accent-soft:#12233f;--accent-ink:#9ec3ff;--chart-1:oklch(0.72 0.14 259);--chart-2:oklch(0.73 0.13 145);--chart-3:oklch(0.77 0.14 70);--chart-4:oklch(0.72 0.16 290);--chart-5:oklch(0.72 0.2 25);--radius:0.625rem;color-scheme:dark';

/**
 * The system preference is the starting point, and an explicit `data-theme` set
 * by the parent wins over it in either direction. Defining every token on bare
 * `:root` first means no variable exists only inside a media query.
 */
const THEME_CSS = `:root{${LIGHT}}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}:root[data-theme="dark"]{${DARK}}:root[data-theme="light"]{${LIGHT}}`;

function decode(b64: string): string {
  if (typeof atob === 'undefined') return '';
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * How many 250ms announce ticks the document keeps trying for before giving up.
 * 240 is a minute — far past any plausible hydration, and bounded so a page the
 * parent never claims does not leave a timer running forever.
 */
const MAX_ANNOUNCE_TICKS = 240;

function buildSrcDoc(code: string, domId: string): string {
  const inner = decode(code);
  const script =
    '(function(){' +
    `var ID=${JSON.stringify(domId)};` +
    "function post(){parent.postMessage({__okpreview:ID,h:document.documentElement.scrollHeight},'*')}" +
    "addEventListener('load',post);" +
    "addEventListener('resize',post);" +
    'if(window.ResizeObserver){new ResizeObserver(post).observe(document.body)}' +
    // Keep announcing until the parent answers, rather than for a fixed window.
    // This document ships inside the server-rendered HTML, so it starts running
    // as the page is parsed, while the parent only begins listening once it
    // hydrates. A bounded window would drop the height and the theme for good
    // on any hydration slower than the window.
    `var n=0,t=setInterval(function(){post();if(++n>${MAX_ANNOUNCE_TICKS})clearInterval(t)},250);` +
    "addEventListener('message',function(e){" +
    'var d=e.data;' +
    'if(!d||d.__okpreview!==ID)return;' +
    // Any reply proves the parent is listening, so stop announcing.
    'clearInterval(t);' +
    // The parent pushes the docs theme in rather than rebuilding this document,
    // so switching theme repaints the preview instead of reloading it.
    "if(typeof d.theme==='string'){document.documentElement.setAttribute('data-theme',d.theme)}" +
    'post()});' +
    '})()';

  return `<!doctype html><html><head><meta charset="utf-8"><style>${THEME_CSS}${BASE}</style></head><body>${inner}<script>${script}</script></body></html>`;
}

export function HtmlPreview({ code }: { code: string }) {
  const { resolvedTheme } = useTheme();
  const domId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const frameRef = useRef<HTMLIFrameElement>(null);

  const [height, setHeight] = useState(
    () => recallPreviewHeight(code) ?? DEFAULT_PREVIEW_RESERVE_PX,
  );
  const [frameLoaded, setFrameLoaded] = useState(false);

  // React may reconcile a preview on one docs page onto the one on the next.
  // Re-deriving here keeps the reserve tied to the block being shown rather
  // than to whatever was measured for the block it replaced.
  const [renderedCode, setRenderedCode] = useState(code);
  if (code !== renderedCode) {
    setRenderedCode(code);
    setHeight(recallPreviewHeight(code) ?? DEFAULT_PREVIEW_RESERVE_PX);
    setFrameLoaded(false);
  }

  useEffect(() => {
    restorePreviewHeights();
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { __okpreview?: string; h?: number } | null;
      if (!d || d.__okpreview !== domId) return;

      // Hearing from the frame is what proves it is running and listening.
      // The load event cannot be relied on here: the iframe ships in the
      // server-rendered HTML, so it often finishes loading before hydration
      // attaches an onLoad handler, and that handler then never fires.
      setFrameLoaded(true);

      if (typeof d.h === 'number') {
        const measured = Math.min(Math.ceil(d.h), MAX_PREVIEW_HEIGHT_PX);
        setHeight(measured);
        rememberPreviewHeight(code, measured);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [domId, code]);

  // Answer the frame once it has announced itself, and again whenever the theme
  // changes. The reply is unconditional even when the theme has not resolved
  // yet: it doubles as the acknowledgement that stops the frame announcing, so
  // withholding it would leave the frame retrying until its cap.
  useEffect(() => {
    if (!frameLoaded) return;
    frameRef.current?.contentWindow?.postMessage({ __okpreview: domId, theme: resolvedTheme }, '*');
  }, [frameLoaded, resolvedTheme, domId]);

  return (
    <iframe
      ref={frameRef}
      title="Interactive preview"
      sandbox="allow-scripts"
      className="not-prose my-5 w-full rounded-2xl border border-fd-border bg-fd-card shadow-sm"
      style={{ height }}
      srcDoc={buildSrcDoc(code, domId)}
      onLoad={() => setFrameLoaded(true)}
    />
  );
}
