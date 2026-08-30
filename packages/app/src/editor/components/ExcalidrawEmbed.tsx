/**
 * ExcalidrawEmbed — renderer for the canonical `<Excalidraw src="…" />`
 * block: a live snapshot of a referenced `.excalidraw` board, with
 * affordances to open the board's own collaborative canvas editor or expand
 * the snapshot to a full-screen lightbox. The by-reference rationale lives
 * on the descriptor in `built-ins.ts`; the scene reaches this component
 * through the shared read-only `live-doc-pool`, so strokes saved on the
 * board re-export the snapshot here without a reload.
 *
 * Containment: the exported SVG never enters the live DOM. It is
 * serialized to a Blob and shown through `<img src="blob:…">` in both the
 * card and the lightbox — SVG-as-image cannot run script, load external
 * resources, or navigate, which closes the whole injected-markup class
 * (remote-`url()` beacons, animation-restored `javascript:` hrefs) without
 * a hand-maintained sanitizer. Cost: snapshot text isn't selectable.
 */

import { isExcalidrawDocFile } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PanzoomObject } from '@panzoom/panzoom';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { hashFromDocName } from '@/lib/doc-hash';
import '@/lib/excalidraw-env';
import { createRetryingLoader } from '@/lib/retrying-loader.ts';
import { cn } from '@/lib/utils.ts';
import { useLiveDocText } from './live-doc-pool.ts';
import { loadPanzoom, PanzoomControls } from './Mermaid.tsx';
import { releaseSnapshotUrl, retainSnapshotUrl } from './snapshot-url-pool.ts';
import { useAppColorMode } from './use-app-color-mode.ts';

type ExcalidrawModule = typeof import('@excalidraw/excalidraw');
type ExcalidrawScene = ReturnType<ExcalidrawModule['restore']>;

const loadExcalidraw = createRetryingLoader(() => import('@excalidraw/excalidraw'));

/** Schemes a board reference may use. Everything else — including `blob:`,
 *  whose origin getter reproduces the page origin and would otherwise slip
 *  through an origin-equality check with a nonsense pathname — is rejected
 *  outright rather than validated by origin proxy. */
const BOARD_SRC_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

/**
 * The board's docName, recovered from the render `src` so the live
 * subscription and the open affordance address the board's doc. Rejects
 * rather than rewrites: a foreign-origin src must not silently become a
 * local read, a decoded `..` segment must not escape the content root, and
 * only `.excalidraw` docNames are addressable at all — an embed can never
 * subscribe to a markdown doc or a config plane through a crafted src.
 * (The server would refuse the traversal anyway — this keeps the CLIENT
 * contract honest so crafted srcs land in the error branch.)
 *
 * `base` is the current document URL. In the packaged desktop that is a
 * `file:` URL, whose origin is opaque per the URL spec — origin equality
 * is meaningless there, so accept `file:` srcs only when the page itself
 * is `file:` (same posture as `client-fetch.ts`).
 */
export function boardDocNameFromSrc(
  src: string,
  base: string = typeof window !== 'undefined' && window.location?.href
    ? window.location.href
    : 'http://localhost/',
): string | null {
  try {
    const baseUrl = new URL(base);
    const url = new URL(src, baseUrl);
    if (!BOARD_SRC_PROTOCOLS.has(url.protocol)) return null;
    const sameOrigin =
      url.protocol === 'file:' ? baseUrl.protocol === 'file:' : url.origin === baseUrl.origin;
    if (!sameOrigin) return null;
    const segments = url.pathname
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
    if (segments.length === 0) return null;
    // A decoded `%2f`/`%5c` re-introduces a separator inside a segment,
    // decoded dot-segments re-introduce traversal, and decoded control
    // characters have no place in a docName — all escape the shape URL
    // normalization already settled, so reject rather than rewrite.
    const smuggled = segments.some(
      (segment) =>
        segment === '..' ||
        segment === '.' ||
        segment.includes('/') ||
        segment.includes('\\') ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
        /[\u0000-\u001f]/.test(segment),
    );
    if (smuggled) return null;
    const docName = segments.join('/');
    if (!isExcalidrawDocFile(docName)) return null;
    return docName;
  } catch {
    return null;
  }
}

interface ExcalidrawEmbedProps {
  src?: string;
  title?: string;
  className?: string;
  /**
   * Host-controlled lightbox state. The expand affordance lives in the
   * block's chrome bar beside Delete and the properties gear (not on the
   * canvas card), so the host owns the boolean and this component owns the
   * dialog it drives. Absent both, the embed renders with no lightbox.
   */
  expandOpen?: boolean;
  onExpandOpenChange?: (open: boolean) => void;
}

type EmbedErrorKind = 'parse' | 'export' | 'module-load';

export function ExcalidrawEmbed({
  src,
  title,
  className,
  expandOpen = false,
  onExpandOpenChange,
}: ExcalidrawEmbedProps) {
  const { t } = useLingui();
  const colorMode = useAppColorMode();
  // Bumped by the error banner's "Try again". On its own it only
  // re-acquires the live subscription — the retry handler additionally
  // clears `scene`/`snapshot` so the idempotency guards below fall through
  // and the parse and export stages genuinely recompute (an export-stage
  // failure leaves `scene` intact, so status identity alone would re-arm
  // nothing).
  const [loadAttempt, setLoadAttempt] = useState(0);

  const boardDocName = src ? boardDocNameFromSrc(src) : null;
  const live = useLiveDocText(boardDocName, loadAttempt);

  // Parse and export are split so a theme toggle re-exports the ALREADY
  // parsed scene in place — it must not re-enter the parse path or blank a
  // painted board. ALL THREE atoms below carry the docName they came from
  // (scene and snapshot additionally carry what produced them): stale
  // values are refused by comparison instead of trusted, so a `src` change
  // can never paint the previous board, resurrect one over an error card,
  // or blame a fresh board for the previous board's failure. The
  // what-produced-it tags also make both effects idempotent across
  // `<Activity>` show cycles, which re-run every effect with unchanged
  // deps (see the WARN rule: hidden Activities unmount effects only).
  const [scene, setScene] = useState<{
    docName: string;
    text: string;
    value: ExcalidrawScene;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{
    docName: string;
    url: string;
    sceneValue: ExcalidrawScene;
    colorMode: 'light' | 'dark';
  } | null>(null);
  const [error, setError] = useState<{ docName: string; kind: EmbedErrorKind } | null>(null);
  // Armed by a retry click, consumed by the focus hand-off effect below;
  // any NEW error disarms it so a stale arm can't steal focus when the
  // board later recovers on its own.
  const containerRef = useRef<HTMLDivElement>(null);
  const retryFocusRef = useRef(false);

  // Warm the ~600 kB Excalidraw chunk (and the lightbox's panzoom chunk)
  // as soon as a board is referenced, in parallel with the WebSocket
  // handshake, instead of serially after sync + JSON.parse. The catch is
  // load-bearing: the retrying loader clears its cache on rejection, so
  // the parse effect still gets a real attempt (and a real error) later.
  useEffect(() => {
    if (!boardDocName) return;
    void loadExcalidraw().catch(() => undefined);
    void loadPanzoom().catch(() => undefined);
  }, [boardDocName]);

  useEffect(() => {
    if (live.kind !== 'ready' || !boardDocName) return;
    // Already parsed exactly this text for exactly this board — an
    // Activity show cycle re-runs effects without a data change.
    if (scene && scene.docName === boardDocName && scene.text === live.text) return;
    let cancelled = false;
    (async () => {
      // A malformed board deliberately ERRORS here (with a log trail),
      // where the board editor renders a blank canvas — an embed silently
      // showing an empty card for a corrupt file would be indistinguishable
      // from a genuinely empty board. `JSON.parse` alone is not enough:
      // valid JSON that isn't a scene (no `elements` array) must land in
      // the same branch, not render as a deceptively empty board.
      const parsed: unknown = JSON.parse(live.text);
      const looksLikeScene =
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { elements?: unknown }).elements);
      if (!looksLikeScene) throw new Error('not an Excalidraw scene (no elements array)');
      // The chunk failing to load is the client's problem, not the
      // board's — it must not be reported as corrupt content.
      let mod: ExcalidrawModule;
      try {
        mod = await loadExcalidraw();
      } catch (err) {
        if (cancelled) return;
        console.warn('[ExcalidrawEmbed] excalidraw module failed to load:', boardDocName, err);
        retryFocusRef.current = false;
        setScene(null);
        setError({ docName: boardDocName, kind: 'module-load' });
        return;
      }
      const value = mod.restore(parsed as Parameters<ExcalidrawModule['restore']>[0], null, null);
      if (cancelled) return;
      setScene({ docName: boardDocName, text: live.text, value });
      setError(null);
    })().catch((err: unknown) => {
      if (cancelled) return;
      console.warn('[ExcalidrawEmbed] failed to parse board:', boardDocName, err);
      retryFocusRef.current = false;
      setScene(null);
      setError({ docName: boardDocName, kind: 'parse' });
    });
    return () => {
      cancelled = true;
    };
  }, [live, boardDocName, scene]);

  // One export at a time: `exportToSvg` has no abort path, so while a
  // remote peer draws (pool re-fires every 150ms) an in-flight export
  // marks itself dirty instead of stacking discarded runs; the trailing
  // kick re-arms the effect once for however many updates were coalesced.
  const exportBusyRef = useRef(false);
  const exportDirtyRef = useRef(false);
  const [exportKick, setExportKick] = useState(0);
  // Previous blob URL, released when the NEXT snapshot commits — not in
  // effect cleanup, because under `<Activity mode="hidden">` effects
  // unmount while the `<img>` (DOM + refs kept) still shows the URL; a
  // cleanup-time revoke would hand a hidden-then-shown image a dead URL.
  // True-unmount leftovers are bounded by the module-level FIFO above
  // (`MAX_LIVE_SNAPSHOT_URLS` outstanding across all mount cycles), not
  // one-per-embed-forever.
  const lastUrlRef = useRef<string | null>(null);

  useEffect(() => {
    void exportKick;
    if (!scene || !boardDocName || scene.docName !== boardDocName) return;
    // This exact scene in this exact theme is already on screen — an
    // Activity show cycle re-runs effects without a data change.
    if (
      snapshot &&
      snapshot.docName === scene.docName &&
      snapshot.sceneValue === scene.value &&
      snapshot.colorMode === colorMode
    ) {
      return;
    }
    if (exportBusyRef.current) {
      exportDirtyRef.current = true;
      return;
    }
    let cancelled = false;
    exportBusyRef.current = true;
    (async () => {
      let mod: ExcalidrawModule;
      try {
        mod = await loadExcalidraw();
      } catch (err) {
        if (cancelled) return;
        console.warn('[ExcalidrawEmbed] excalidraw module failed to load:', boardDocName, err);
        retryFocusRef.current = false;
        setSnapshot(null);
        setError({ docName: boardDocName, kind: 'module-load' });
        return;
      }
      const svg = await mod.exportToSvg({
        elements: scene.value.elements,
        appState: {
          ...scene.value.appState,
          exportWithDarkMode: colorMode === 'dark',
          // Transparent, so the snapshot sits on the card background the
          // way the mermaid canvas does instead of a white plate.
          exportBackground: false,
        },
        files: scene.value.files,
      });
      if (cancelled) return;
      const markup = new XMLSerializer().serializeToString(svg);
      const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
      const prev = lastUrlRef.current;
      lastUrlRef.current = url;
      retainSnapshotUrl(url);
      if (prev) releaseSnapshotUrl(prev);
      setSnapshot({ docName: scene.docName, url, sceneValue: scene.value, colorMode });
      setError(null);
    })()
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('[ExcalidrawEmbed] failed to export board snapshot:', boardDocName, err);
        retryFocusRef.current = false;
        setSnapshot(null);
        setError({ docName: boardDocName, kind: 'export' });
      })
      .finally(() => {
        exportBusyRef.current = false;
        if (exportDirtyRef.current) {
          exportDirtyRef.current = false;
          setExportKick((n) => n + 1);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scene, colorMode, boardDocName, snapshot, exportKick]);

  const currentError = error && error.docName === boardDocName ? error : null;
  const showError =
    currentError !== null || live.kind === 'unreachable' || live.kind === 'at-capacity';
  const currentSnapshot = snapshot && snapshot.docName === boardDocName ? snapshot : null;
  const expandable = currentSnapshot !== null && !showError;

  // After a user-initiated retry resolves, the banner (and the button that
  // held focus) unmounts — move focus to the card so keyboard and
  // screen-reader users don't drop to document.body. Only retry clicks arm
  // this; an automatic recovery must not steal focus from the editor.
  useEffect(() => {
    if (!showError && retryFocusRef.current) {
      retryFocusRef.current = false;
      containerRef.current?.focus();
    }
  }, [showError]);

  // Close the host's expand boolean only on TERMINAL states (error /
  // unreachable / at-capacity / empty). A request made during the load
  // window stays pending and the dialog opens the moment the snapshot
  // lands — dropping it instead would make the chrome button a dead click
  // while loading.
  const dropExpand = showError || live.kind === 'empty';
  useEffect(() => {
    if (expandOpen && dropExpand) onExpandOpenChange?.(false);
  }, [expandOpen, dropExpand, onExpandOpenChange]);

  if (!src) {
    // No board chosen yet — say so and name the next step, rather than
    // claiming an (empty) board exists. The properties gear is the only
    // real affordance until a picker ships.
    return (
      <div
        className={cn(
          'excalidraw-embed flex min-h-16 w-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/10 px-3 py-6 text-sm text-muted-foreground',
          className,
        )}
        data-component-type="excalidraw"
      >
        <Trans>
          No board selected. Enter the path to a .excalidraw doc in this block's properties.
        </Trans>
      </div>
    );
  }

  if (live.kind === 'empty') {
    // Passive (mirrors the mermaid empty card), because an empty board is
    // an expected state — freshly created, nothing drawn yet — not a
    // failure. Real height so the block keeps a click target + chrome.
    return (
      <div
        className={cn(
          'excalidraw-embed flex min-h-16 w-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/10 px-3 py-6 text-sm text-muted-foreground',
          className,
        )}
        data-component-type="excalidraw"
      >
        <Trans>Empty board</Trans>
      </div>
    );
  }

  const isLoading = !showError && !currentSnapshot;
  const errorDetail =
    live.kind === 'at-capacity'
      ? t`Too many live references on this page. This board was not loaded.`
      : live.kind === 'unreachable'
        ? t`The board could not be reached. It may not exist, or the server may be offline.`
        : currentError?.kind === 'module-load'
          ? t`The board viewer failed to load. Check your connection and try again.`
          : currentError?.kind === 'parse'
            ? t`The board's content is not a valid Excalidraw scene.`
            : t`The board snapshot could not be rendered.`;
  // No retry affordance where a retry provably cannot succeed: an
  // at-capacity refusal is a no-op until other references release, and a
  // `src` the resolver rejected stays rejected — the input doesn't change
  // on a click (it needs a property-panel edit).
  const retryable = showError && live.kind !== 'at-capacity' && boardDocName !== null;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={cn(
        'excalidraw-embed relative w-full overflow-hidden rounded-md border border-border/60 bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      data-component-type="excalidraw"
      aria-busy={isLoading ? true : undefined}
    >
      {showError ? (
        <div
          role="alert"
          className="m-2 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
        >
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              <Trans>Excalidraw board failed to load.</Trans>
            </div>
            {/* Fixed copy + the docName only — never the raw error message,
                which can echo referenced-doc content into the card. The
                full error goes to the console for diagnosis. */}
            <div className="mt-1">{errorDetail}</div>
            <div className="mt-1 break-words font-mono text-[11px] opacity-90">
              {boardDocName ?? src}
            </div>
          </div>
          {retryable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0 border-destructive/40 text-destructive hover:text-destructive"
              data-testid="excalidraw-embed-retry"
              onClick={() => {
                retryFocusRef.current = true;
                setError(null);
                // Invalidate the derived stages, not just the subscription:
                // an export-stage failure leaves `scene` intact, so the
                // idempotency guards would otherwise return early and the
                // retry would be a dead click onto a permanent skeleton.
                setScene(null);
                setSnapshot(null);
                setLoadAttempt((n) => n + 1);
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {currentSnapshot && !showError ? (
        <div
          className="flex min-h-16 w-full items-center justify-center p-3"
          data-testid="excalidraw-embed-snapshot"
        >
          <img
            src={currentSnapshot.url}
            alt={title || t`Excalidraw board`}
            draggable={false}
            className="h-auto max-h-[60vh] max-w-full"
            onError={() => {
              // A snapshot URL that fails to decode (e.g. revoked out from
              // under a hidden Activity in an edge we missed) must surface
              // as the error card, not a bare broken-image glyph. A DOM
              // error event carries no error object, so log the condition
              // — it's otherwise indistinguishable from an export failure.
              console.warn(
                '[ExcalidrawEmbed] snapshot image failed to decode:',
                boardDocName,
                currentSnapshot?.url,
              );
              if (boardDocName) {
                retryFocusRef.current = false;
                setError({ docName: boardDocName, kind: 'export' });
              }
            }}
          />
        </div>
      ) : null}
      {isLoading ? (
        <div className="m-3 min-h-16 animate-pulse rounded-md bg-muted/40" aria-hidden="true" />
      ) : null}
      {boardDocName && !showError ? (
        <Button
          asChild
          size="icon-sm"
          variant="secondary"
          className="absolute top-2 right-2 border-border"
          title={t`Open board`}
          data-testid="excalidraw-embed-open"
        >
          {/* A real anchor (not an onClick hash write) so cmd/middle-click
              and "copy link" work — same affordance contract as Mirror's
              open-source link. */}
          <a href={hashFromDocName(boardDocName)} aria-label={t`Open board`}>
            <ExternalLink className="size-4" aria-hidden="true" />
          </a>
        </Button>
      ) : null}
      <ExcalidrawLightbox
        open={expandOpen && expandable}
        onOpenChange={(next) => onExpandOpenChange?.(next)}
        snapshotUrl={currentSnapshot?.url ?? null}
        title={title}
      />
    </div>
  );
}

const LIGHTBOX_ZOOM_MIN = 0.5;
const LIGHTBOX_ZOOM_MAX = 4;
const LIGHTBOX_ZOOM_STEP = 0.25;

/**
 * Full-screen viewer for a board snapshot — the mermaid lightbox shape
 * applied to Excalidraw. Kept mounted and driven by `open` so Radix runs
 * the exit animation; the body is an `<img>` on the embed's latest blob
 * snapshot, so a board edit landing while the dialog is open swaps the
 * image in place (panzoom stays bound to the same element).
 */
function ExcalidrawLightbox({
  open,
  onOpenChange,
  snapshotUrl,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshotUrl: string | null;
  title?: string;
}) {
  const { t } = useLingui();
  const panzoomRef = useRef<PanzoomObject | null>(null);
  const [panzoomFailed, setPanzoomFailed] = useState(false);

  // Pan/zoom arms through the image's ref callback, not an `open`-keyed
  // effect: the dialog content's DOM node isn't guaranteed to exist in the
  // commit where `open` flips, and the ref callback is the one signal that
  // fires exactly when the node is really in the DOM (and its cleanup when
  // it leaves).
  const attachImage = (img: HTMLImageElement | null) => {
    if (!img) return undefined;
    let disposed = false;
    loadPanzoom()
      .then((Panzoom) => {
        if (disposed) return;
        panzoomRef.current = Panzoom(img, {
          canvas: true,
          cursor: 'default',
          maxScale: LIGHTBOX_ZOOM_MAX,
          minScale: LIGHTBOX_ZOOM_MIN,
          step: LIGHTBOX_ZOOM_STEP,
          noBind: true,
          touchAction: 'auto',
        });
        setPanzoomFailed(false);
      })
      .catch((err) => {
        console.warn('[ExcalidrawEmbed] panzoom setup failed:', err);
        if (!disposed) setPanzoomFailed(true);
      });
    // The dialog owns its whole viewport, so a two-finger scroll pans the
    // board and a pinch/ctrl-wheel zooms — same contract as the mermaid
    // whole-viewport surfaces.
    const onWheel = (e: WheelEvent) => {
      const pz = panzoomRef.current;
      if (!pz) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        pz.zoomWithWheel(e);
        return;
      }
      const scale = typeof pz.getScale === 'function' ? pz.getScale() : 1;
      const denom = scale > 0 ? scale : 1;
      pz.pan(-e.deltaX / denom, -e.deltaY / denom, { relative: true });
    };
    const host = img.parentElement;
    host?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      disposed = true;
      host?.removeEventListener('wheel', onWheel);
      panzoomRef.current?.destroy();
      panzoomRef.current = null;
    };
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[calc(100dvh-5rem)] w-[calc(100dvw-5rem)] max-w-none gap-0 p-2 pt-10 duration-200 sm:max-w-none"
        // Same zoom-travel treatment as the mermaid lightbox: the vars feed
        // tw-animate-css's keyframes; inline style wins over the default
        // zoom-in-95 class without fighting tailwind-merge.
        style={{ '--tw-enter-scale': '0.92', '--tw-exit-scale': '0.92' } as React.CSSProperties}
      >
        <DialogTitle className="sr-only">{title || t`Excalidraw board`}</DialogTitle>
        <span className="absolute top-2 left-3 flex h-7 items-center text-xs text-muted-foreground">
          {t`View only`}
        </span>
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div
            className="flex min-h-0 flex-1 items-center justify-center"
            data-testid="excalidraw-lightbox-canvas"
          >
            {snapshotUrl ? (
              <img
                ref={attachImage}
                src={snapshotUrl}
                alt={title || t`Excalidraw board`}
                draggable={false}
                className="max-h-full max-w-full"
              />
            ) : null}
          </div>
          <PanzoomControls
            panzoomRef={panzoomRef}
            label={t`Board controls`}
            testId="excalidraw-lightbox-actions"
            unavailable={panzoomFailed}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
