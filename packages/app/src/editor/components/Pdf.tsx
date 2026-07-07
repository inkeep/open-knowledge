/**
 * Pdf — PDF.js-backed canonical for the `Pdf` descriptor (`![[doc.pdf]]`
 * wiki-embed + `<Pdf src="..." />` JSX). Uses `pdfjs-dist` to render each
 * page to its own `<canvas>` in a scrollable container — no `<iframe>`,
 * no browser-native chrome. Owning the rendering keeps every visual
 * detail (page background, gap, page-indicator, toolbar) under our
 * control and consistent across browsers, and gives us a substrate
 * for future features (annotations, highlight overlays, custom search
 * UI) that an opaque sub-renderer wouldn't allow.
 *
 * ── Toolbar ────────────────────────────────────────────────────────────────
 *
 * Layout:
 *   [thumbnails toggle] [title] [page input / N] [zoom-] [%] [zoom+] [layout ▾]
 *
 * Page navigation is an editable input (jump-anywhere), not arrow keys —
 * Enter or blur commits. The current page tracks scroll position so the
 * input value updates as the reader scrolls. Zoom is a multiplier on top
 * of the layout-mode base scale (fit-width / fit-height / single / two-up
 * variants), so zoom and layout compose. Thumbnails sidebar is a small
 * column of page mini-renders; clicking jumps to the page.
 *
 * ── Bundle discipline ───────────────────────────────────────────────────────
 *
 * `pdfjs-dist` is ~300 KB gzipped — too heavy for the main app chunk
 * (size-limit budget: 340 KB gzipped). We dynamic-import inside an effect
 * so Vite splits PDF.js into its own chunk that only loads when a doc
 * actually has a `Pdf` embed. The component itself stays small enough to
 * live in `componentMap` eagerly without busting the budget; the heavy
 * library cost is paid lazily.
 *
 * The PDF.js worker (~100 KB gzipped, internal to the library) is
 * dynamic-imported by `pdfjs-dist` itself via `?url` — Vite resolves
 * the worker bundle separately at build time. Configured at module
 * load via `GlobalWorkerOptions.workerSrc`.
 *
 * ── Anchor parsing ───────────────────────────────────────────────────────────
 *
 * `props.anchor` is a single string from the wikiLinkEmbed slot:
 *   - `page=N`   → scroll to page N on first render
 *   - `height=N` → container height in px (default 600)
 *   - everything else → currently ignored (forward-compat space for
 *     `zoom=N`, `view=Fit`, etc.)
 *
 * Parsing lives in `core/utils/pdf-anchor.ts` (`parsePdfAnchor`) so the
 * precision suite can exercise it without crossing the core→app
 * dependency boundary.
 */

import { parsePdfAnchor, toDesktopAssetHref } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronDown, PanelLeft, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { computeBaseScale, type PdfLayoutMode } from './pdf-layout.ts';

interface PdfProps {
  src?: string;
  title?: string;
  /** Single string from the wikiLinkEmbed anchor slot. Possibly empty. */
  anchor?: string;
  /** When `true`, the viewer fills its parent container's height instead of
   * the default fixed `DEFAULT_HEIGHT_PX`. Used by route-level surfaces
   * (`AssetPreview` for `#/__asset__/<path>.pdf`) where the host gives the
   * viewer the full editor pane to work with; inline `<Pdf>` inside a
   * markdown doc keeps the fixed-height behavior so it sits among other
   * blocks. Explicit `height=N` in `anchor` still wins — the contract is
   * "fill the host unless the author pinned a height." */
  fillContainer?: boolean;
}

const DEFAULT_HEIGHT_PX = 600;

/** Layout presets — each maps to a different way of computing the base
 *  render scale and how pages flow in the page container.
 *
 *  - `fit-width`   — one column; page scaled so its width fills the column.
 *  - `fit-height`  — one column; page scaled so its height fills the
 *                    available viewport (toolbar minus container height).
 *  - `single`      — one column; page rendered at natural (scale=1) size.
 *  - `two-odd`     — two columns; pairs (1,2) (3,4) …
 *  - `two-even`    — two columns; page 1 alone on the right (cover),
 *                    then pairs (2,3) (4,5) … (book-style).
 *
 *  Keep this alias in sync with `pdf-layout.ts`'s `PdfLayoutMode` — the
 *  helper module is the single source of truth for the string union, and
 *  `computeBaseScale` is exhaustively tested over every member there.
 */
type LayoutMode = PdfLayoutMode;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.25;

/**
 * Module-level singleton that lazy-loads `pdfjs-dist` + the worker on
 * first use. Must live OUTSIDE the component body — React Compiler's
 * Babel plugin doesn't lower `await import(...)` expressions inside
 * function components (BuildHIR::lowerExpression refuses Import nodes
 * in the component HIR). Hoisting to module scope means the dynamic
 * imports run once at module-load time when a Pdf renders, the chunk
 * splits cleanly, and the React-Compiled component sees only a stable
 * `Promise` reference.
 */
type PdfJsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJsModule> | null = null;
function loadPdfjs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = await import('pdfjs-dist');
      if (!mod.GlobalWorkerOptions.workerSrc) {
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
        mod.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      return mod;
    })();
    // If the dynamic import rejects (transient chunk-load failure, CDN
    // hiccup), null the cache so the next call retries instead of
    // returning the same rejected promise forever. Without this, one
    // network blip turns into a session-scoped "no PDF will ever load"
    // outage requiring a full page reload.
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

/** Per-page natural metadata (scale=1 viewport dims). Stable across zoom
 *  / layout changes — captured once when the document loads. */
interface PageInfo {
  pageNumber: number;
  naturalWidth: number;
  naturalHeight: number;
}

type PdfDoc = import('pdfjs-dist').PDFDocumentProxy;

/** Recognise pdfjs-dist's `RenderingCancelledException` so cleanup-driven
 *  cancellations don't surface as unhandled rejections / console errors.
 *  The exception is thrown when `RenderTask.cancel()` aborts an in-flight
 *  render; it's expected behavior, not a failure. We match by `.name`
 *  rather than `instanceof` because pdfjs-dist's internal exception class
 *  isn't exported from the public API. */
function isRenderingCancelledError(err: unknown): boolean {
  return err instanceof Error && err.name === 'RenderingCancelledException';
}

/**
 * DIY Pdf. Descriptor-dispatched via `componentMap['Pdf']`. Renders the
 * full document as a vertical stack of `<canvas>` elements (Obsidian-
 * parity layout — every page visible, scroll to navigate).
 */
export function Pdf(props: PdfProps) {
  const { height: anchorHeight, viewerFragment } = parsePdfAnchor(props.anchor);
  // Explicit `anchor=height=N` always wins; otherwise the host decides
  // — `fillContainer` mode uses CSS `100%` so the route-level
  // `AssetPreview` viewport governs sizing, and the inline default
  // falls back to `DEFAULT_HEIGHT_PX` for block-layout contexts.
  // `parsePdfAnchor`'s height is `number | null` (never `undefined`).
  const heightStyle: string =
    anchorHeight !== null
      ? `${anchorHeight}px`
      : props.fillContainer
        ? '100%'
        : `${DEFAULT_HEIGHT_PX}px`;

  // Parse `page=N` from the viewer fragment for first-render scroll.
  const targetPage = parseTargetPage(viewerFragment);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const thumbRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const docRef = useRef<PdfDoc | null>(null);

  const [pages, setPages] = useState<PageInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(targetPage ?? 1);
  const [pageInputValue, setPageInputValue] = useState<string>(String(targetPage ?? 1));
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('fit-width');
  const [showThumbs, setShowThumbs] = useState<boolean>(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState<boolean>(false);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  const { t } = useLingui();

  const totalPages = pages.length;

  // Effect 1 — load the document + capture per-page natural dimensions.
  // Runs only on `props.src` change; layout/zoom changes do NOT reload.
  useEffect(() => {
    if (!props.src) {
      setLoading(false);
      return;
    }
    // Under Electron the renderer page origin has no asset middleware — rewrite
    // a server-absolute src onto `apiOrigin` (no-op in web/CLI builds).
    const docUrl = toDesktopAssetHref(props.src);
    let cancelled = false;
    let activeDoc: PdfDoc | null = null;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // `isEvalSupported: false` — defense-in-depth for hosts deployed
        // under a CSP without `unsafe-eval`. The default lets PDF.js use
        // `new Function()` for optimized CMap processing; the `false` path
        // is functionally equivalent at slightly higher CPU cost. Every
        // other media canonical avoids eval-adjacent code paths; PDF
        // should match. The `as` cast widens past pdfjs's overload
        // ambiguity (`{url}` matches the URL-shorthand overload first).
        const doc = await pdfjs.getDocument({
          url: docUrl,
          isEvalSupported: false,
        } as Parameters<typeof pdfjs.getDocument>[0]).promise;
        if (cancelled) {
          await doc.destroy();
          return;
        }
        activeDoc = doc;
        docRef.current = doc;

        const meta: PageInfo[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
          if (cancelled) return;
          const page = await doc.getPage(pageNumber);
          const v = page.getViewport({ scale: 1 });
          meta.push({ pageNumber, naturalWidth: v.width, naturalHeight: v.height });
        }
        if (cancelled) return;
        setPages(meta);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t`Failed to load PDF`);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // Release worker state + decoded page trees + font caches.
      // `destroy()` returns a Promise, but we don't await it — React's
      // cleanup function is sync, and the destroy is fire-and-forget.
      if (activeDoc) {
        void activeDoc.destroy();
        activeDoc = null;
      }
      docRef.current = null;
    };
  }, [props.src, t]);

  // Track container dimensions so fit-width / fit-height can compute
  // the right scale. ResizeObserver fires on initial mount + every
  // resize, so the page list re-flows when the user toggles thumbnails
  // or the host page resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setContainerWidth(el.clientWidth);
      setContainerHeight(el.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Effect 2 — render every page's main canvas at the current effective
  // scale. Re-runs on layout / zoom / container-size / pages change so
  // the displayed render always matches what the toolbar says.
  //
  // The `cancelled` flag prevents *new* loop iterations after the
  // effect tears down, but it doesn't abort an already-dispatched
  // `page.render()`. We store the active `RenderTask` so cleanup can
  // call `.cancel()` — that aborts the GPU work instead of letting it
  // run to completion. The await rejects with a
  // `RenderingCancelledException` which we swallow; any other error
  // (decode failure, OOM) is logged so it's visible in the console.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || pages.length === 0 || containerWidth === 0) return;
    let cancelled = false;
    let activeRenderTask: import('pdfjs-dist').RenderTask | null = null;

    (async () => {
      try {
        const dpr = window.devicePixelRatio || 1;
        for (const info of pages) {
          if (cancelled) return;
          const canvas = pageRefs.current[info.pageNumber - 1];
          if (!canvas) continue;
          const baseScale = computeBaseScale(layoutMode, info, containerWidth, containerHeight);
          const effectiveScale = baseScale * zoomScale;
          const page = await doc.getPage(info.pageNumber);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: effectiveScale });

          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          // Reset transform so re-renders don't compound the dpr scale.
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          activeRenderTask = page.render({ canvas, canvasContext: ctx, viewport });
          await activeRenderTask.promise;
          activeRenderTask = null;
        }
        if (!cancelled) setLoading(false);
      } catch (err) {
        if (cancelled || isRenderingCancelledError(err)) return;
        // Surface non-cancellation errors to the UI so the user gets a
        // visible failure state instead of a perpetual loading spinner.
        // Console log in addition for DevTools triage.
        console.warn('[Pdf] page render failed:', err);
        setError(err instanceof Error ? err.message : t`Failed to render PDF`);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // Abort any in-flight render so the GPU work stops and the awaited
      // promise rejects with a cancellation error (swallowed in the
      // catch above).
      if (activeRenderTask) {
        try {
          activeRenderTask.cancel();
        } catch {
          // RenderTask.cancel() can throw if already settled — harmless.
        }
        activeRenderTask = null;
      }
    };
  }, [pages, layoutMode, zoomScale, containerWidth, containerHeight, t]);

  // Effect 3 — render thumbnails when the sidebar is visible. Each
  // thumbnail is a fixed ~120 px wide canvas; render once per show-
  // toggle, no re-render on zoom (thumbnails are zoom-independent).
  // Same cancellation discipline as Effect 2: an in-flight render gets
  // `.cancel()`-ed on cleanup; the resulting cancellation error is
  // swallowed so it doesn't surface as an unhandled promise rejection.
  useEffect(() => {
    if (!showThumbs) return;
    const doc = docRef.current;
    if (!doc || pages.length === 0) return;
    let cancelled = false;
    let activeRenderTask: import('pdfjs-dist').RenderTask | null = null;
    (async () => {
      try {
        const dpr = window.devicePixelRatio || 1;
        for (const info of pages) {
          if (cancelled) return;
          const canvas = thumbRefs.current[info.pageNumber - 1];
          if (!canvas) continue;
          const thumbScale = 120 / info.naturalWidth;
          const page = await doc.getPage(info.pageNumber);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: thumbScale });
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          activeRenderTask = page.render({ canvas, canvasContext: ctx, viewport });
          await activeRenderTask.promise;
          activeRenderTask = null;
        }
      } catch (err) {
        if (!isRenderingCancelledError(err)) {
          console.warn('[Pdf] thumbnail render failed:', err);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (activeRenderTask) {
        try {
          activeRenderTask.cancel();
        } catch {
          // see Effect 2 for rationale.
        }
        activeRenderTask = null;
      }
    };
  }, [showThumbs, pages]);

  // Scroll target page into view on first render once pages are ready.
  // Mutate `container.scrollTop` directly rather than `scrollIntoView`
  // — the latter walks up through every scrollable ancestor including
  // the document, so a `page=3` on one of several embedded PDFs would
  // also scroll the host page to that PDF (and push our own toolbar
  // out of view in the process). Local-only scroll keeps the embed
  // self-contained.
  useEffect(() => {
    if (loading || !targetPage) return;
    const container = containerRef.current;
    const canvas = pageRefs.current[targetPage - 1];
    if (container && canvas) {
      container.scrollTop = canvas.offsetTop - container.offsetTop;
    }
  }, [loading, targetPage]);

  // Track which page is "current" based on scroll position so the
  // page input updates as the user scrolls.
  //
  // Throttled via `requestAnimationFrame` — the scroll event fires
  // ~60+ Hz on most platforms but the per-frame loop over every page
  // only needs to run once per paint. Without rAF we'd queue a
  // setState for every wheel tick, which is fine today (React's
  // same-value bailout collapses no-op updates) but stops scaling for
  // very-large-PDF or trackpad-scroll spam scenarios. The pending
  // flag prevents queueing more than one frame at a time.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || pages.length === 0) return;
    let pending = false;
    const onScroll = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const containerTop = container.scrollTop;
        let active = 1;
        for (const page of pages) {
          const canvas = pageRefs.current[page.pageNumber - 1];
          if (!canvas) continue;
          if (canvas.offsetTop - container.offsetTop <= containerTop + 40) {
            active = page.pageNumber;
          }
        }
        setCurrentPage(active);
        setPageInputValue(String(active));
      });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [pages]);

  // Close the layout menu on outside click. Bound to mousedown so the
  // close fires before any other click target tries to handle the event.
  useEffect(() => {
    if (!layoutMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const root = containerRef.current?.closest('.ok-pdf');
      if (!root || !target || !root.contains(target)) {
        setLayoutMenuOpen(false);
        return;
      }
      const menu = root.querySelector('.ok-pdf-layout-menu');
      if (menu && !menu.contains(target)) setLayoutMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [layoutMenuOpen]);

  const goToPage = (page: number) => {
    const clamped = Math.max(1, Math.min(totalPages || 1, page));
    setCurrentPage(clamped);
    setPageInputValue(String(clamped));
    const container = containerRef.current;
    const canvas = pageRefs.current[clamped - 1];
    if (container && canvas) {
      // Local-only scroll. `scrollIntoView` would propagate to the host
      // page's scroll container too (clipping the embed's own toolbar).
      container.scrollTo({
        top: canvas.offsetTop - container.offsetTop,
        behavior: 'smooth',
      });
    }
  };

  const submitPageInput = () => {
    const n = Number.parseInt(pageInputValue, 10);
    if (Number.isNaN(n)) {
      setPageInputValue(String(currentPage));
      return;
    }
    goToPage(n);
  };

  const zoomIn = () => setZoomScale((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
  const zoomOut = () => setZoomScale((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)));
  const selectLayout = (mode: LayoutMode) => {
    setLayoutMode(mode);
    setLayoutMenuOpen(false);
    // Reset zoom on layout switch so the user gets a sensible default
    // view (otherwise a 3x zoom carried over from a fit-width view will
    // overflow the container in single-page mode and confuse things).
    setZoomScale(1);
  };

  return (
    <div className="ok-pdf" style={{ height: heightStyle }}>
      <div className="ok-pdf-toolbar" contentEditable={false}>
        <button
          type="button"
          onClick={() => setShowThumbs((v) => !v)}
          aria-label={showThumbs ? t`Hide thumbnails` : t`Show thumbnails`}
          aria-pressed={showThumbs}
          className="ok-pdf-btn"
          title={t`Toggle thumbnails`}
        >
          <PanelLeft size={14} aria-hidden="true" />
        </button>
        <span className="ok-pdf-title">{props.title ?? 'PDF'}</span>
        {totalPages > 0 && (
          <div className="ok-pdf-controls">
            <form
              className="ok-pdf-page-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitPageInput();
              }}
            >
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                className="ok-pdf-page-input"
                value={pageInputValue}
                onChange={(e) => setPageInputValue(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={submitPageInput}
                aria-label={t`Page number`}
              />
            </form>
            <span className="ok-pdf-page-of">
              <Trans>of {totalPages}</Trans>
            </span>

            <span className="ok-pdf-divider" aria-hidden="true" />

            <button
              type="button"
              onClick={zoomOut}
              disabled={zoomScale <= ZOOM_MIN}
              aria-label={t`Zoom out`}
              className="ok-pdf-btn"
              title={t`Zoom out`}
            >
              <ZoomOut size={14} aria-hidden="true" />
            </button>
            <span className="ok-pdf-zoom-display" aria-live="polite">
              {Math.round(zoomScale * 100)}%
            </span>
            <button
              type="button"
              onClick={zoomIn}
              disabled={zoomScale >= ZOOM_MAX}
              aria-label={t`Zoom in`}
              className="ok-pdf-btn"
              title={t`Zoom in`}
            >
              <ZoomIn size={14} aria-hidden="true" />
            </button>

            <span className="ok-pdf-divider" aria-hidden="true" />

            <div className="ok-pdf-layout-menu">
              <button
                type="button"
                onClick={() => setLayoutMenuOpen((v) => !v)}
                aria-label={t`Layout options`}
                aria-haspopup="menu"
                aria-expanded={layoutMenuOpen}
                className="ok-pdf-btn"
                title={t`Layout`}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {layoutMenuOpen && (
                <div role="menu" className="ok-pdf-menu">
                  <LayoutMenuItem
                    label={t`Fit width`}
                    active={layoutMode === 'fit-width'}
                    onSelect={() => selectLayout('fit-width')}
                  />
                  <LayoutMenuItem
                    label={t`Fit height`}
                    active={layoutMode === 'fit-height'}
                    onSelect={() => selectLayout('fit-height')}
                  />
                  <hr className="ok-pdf-menu-divider" />
                  <LayoutMenuItem
                    label={t`Single page`}
                    active={layoutMode === 'single'}
                    onSelect={() => selectLayout('single')}
                  />
                  <LayoutMenuItem
                    label={t`Two-page (odd)`}
                    active={layoutMode === 'two-odd'}
                    onSelect={() => selectLayout('two-odd')}
                  />
                  <LayoutMenuItem
                    label={t`Two-page (even)`}
                    active={layoutMode === 'two-even'}
                    onSelect={() => selectLayout('two-even')}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="ok-pdf-body">
        {showThumbs && (
          <aside className="ok-pdf-sidebar" aria-label={t`Page thumbnails`}>
            {pages.map((info, i) => {
              const { pageNumber } = info;
              return (
                <button
                  type="button"
                  key={pageNumber}
                  className="ok-pdf-thumb"
                  data-active={currentPage === pageNumber || undefined}
                  onClick={() => goToPage(pageNumber)}
                  aria-label={t`Jump to page ${pageNumber}`}
                >
                  <canvas
                    ref={(el) => {
                      thumbRefs.current[i] = el;
                    }}
                    className="ok-pdf-thumb-canvas"
                  />
                  <span className="ok-pdf-thumb-num">{pageNumber}</span>
                </button>
              );
            })}
          </aside>
        )}
        <div className="ok-pdf-pages" ref={containerRef} data-layout={layoutMode}>
          {loading && (
            <div className="ok-pdf-loading">
              <Trans>Loading PDF</Trans>
            </div>
          )}
          {error && (
            <div className="ok-pdf-error">
              <Trans>Failed to load PDF: {error}</Trans>
            </div>
          )}
          {/* Render canvas slots regardless of loading so refs exist when
              the render effect runs. Stable allocation keyed on page
              number keeps refs aligned across re-renders. */}
          {Array.from({ length: totalPages }, (_, i) => {
            const pageNumber = i + 1;
            return (
              <canvas
                key={pageNumber}
                ref={(el) => {
                  pageRefs.current[i] = el;
                }}
                className="ok-pdf-page"
                aria-label={t`Page ${pageNumber}`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface LayoutMenuItemProps {
  label: string;
  active: boolean;
  onSelect: () => void;
}

function LayoutMenuItem(props: LayoutMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.active}
      className="ok-pdf-menu-item"
      data-active={props.active || undefined}
      onClick={props.onSelect}
    >
      <span className="ok-pdf-menu-check" aria-hidden="true">
        {props.active && <Check size={14} />}
      </span>
      {props.label}
    </button>
  );
}

/**
 * Extract `page=N` from a URL-fragment-shaped string. Returns the page
 * number or null if absent / malformed. Lives in this file (rather than
 * `pdf-anchor.ts`) because the canvas renderer interprets `page=N` itself
 * by scrolling the matching `<canvas>` slot into view — there's no URL
 * fragment passthrough since we don't hand the document off to a sub-
 * renderer.
 */
function parseTargetPage(viewerFragment: string): number | null {
  if (!viewerFragment) return null;
  for (const segment of viewerFragment.split('&')) {
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    if (segment.slice(0, eq) === 'page') {
      const n = Number.parseInt(segment.slice(eq + 1), 10);
      if (!Number.isNaN(n) && n >= 1) return n;
    }
  }
  return null;
}
