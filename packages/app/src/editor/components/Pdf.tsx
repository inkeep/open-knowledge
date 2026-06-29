
import { parsePdfAnchor, toDesktopAssetHref } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronDown, PanelLeft, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { computeBaseScale, type PdfLayoutMode } from './pdf-layout.ts';

interface PdfProps {
  src?: string;
  title?: string;
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

export function Pdf(props: PdfProps) {
  const { height: anchorHeight, viewerFragment } = parsePdfAnchor(props.anchor);
  const heightStyle: string =
    anchorHeight !== null
      ? `${anchorHeight}px`
      : props.fillContainer
        ? '100%'
        : `${DEFAULT_HEIGHT_PX}px`;

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

  useEffect(() => {
    if (!props.src) {
      setLoading(false);
      return;
    }
    const docUrl = toDesktopAssetHref(props.src);
    let cancelled = false;
    let activeDoc: PdfDoc | null = null;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const pdfjs = await loadPdfjs();
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
      if (activeDoc) {
        void activeDoc.destroy();
        activeDoc = null;
      }
      docRef.current = null;
    };
  }, [props.src, t]);

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
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          activeRenderTask = page.render({ canvas, canvasContext: ctx, viewport });
          await activeRenderTask.promise;
          activeRenderTask = null;
        }
        if (!cancelled) setLoading(false);
      } catch (err) {
        if (cancelled || isRenderingCancelledError(err)) return;
        console.warn('[Pdf] page render failed:', err);
        setError(err instanceof Error ? err.message : t`Failed to render PDF`);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (activeRenderTask) {
        try {
          activeRenderTask.cancel();
        } catch {
        }
        activeRenderTask = null;
      }
    };
  }, [pages, layoutMode, zoomScale, containerWidth, containerHeight, t]);

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
        }
        activeRenderTask = null;
      }
    };
  }, [showThumbs, pages]);

  useEffect(() => {
    if (loading || !targetPage) return;
    const container = containerRef.current;
    const canvas = pageRefs.current[targetPage - 1];
    if (container && canvas) {
      container.scrollTop = canvas.offsetTop - container.offsetTop;
    }
  }, [loading, targetPage]);

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
