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

const BOARD_SRC_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

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
  const [loadAttempt, setLoadAttempt] = useState(0);

  const boardDocName = src ? boardDocNameFromSrc(src) : null;
  const live = useLiveDocText(boardDocName, loadAttempt);

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
  const containerRef = useRef<HTMLDivElement>(null);
  const retryFocusRef = useRef(false);

  useEffect(() => {
    if (!boardDocName) return;
    void loadExcalidraw().catch(() => undefined);
    void loadPanzoom().catch(() => undefined);
  }, [boardDocName]);

  useEffect(() => {
    if (live.kind !== 'ready' || !boardDocName) return;
    if (scene && scene.docName === boardDocName && scene.text === live.text) return;
    let cancelled = false;
    (async () => {
      const parsed: unknown = JSON.parse(live.text);
      const looksLikeScene =
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { elements?: unknown }).elements);
      if (!looksLikeScene) throw new Error('not an Excalidraw scene (no elements array)');
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

  const exportBusyRef = useRef(false);
  const exportDirtyRef = useRef(false);
  const [exportKick, setExportKick] = useState(0);
  const lastUrlRef = useRef<string | null>(null);

  useEffect(() => {
    void exportKick;
    if (!scene || !boardDocName || scene.docName !== boardDocName) return;
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

  useEffect(() => {
    if (!showError && retryFocusRef.current) {
      retryFocusRef.current = false;
      containerRef.current?.focus();
    }
  }, [showError]);

  const dropExpand = showError || live.kind === 'empty';
  useEffect(() => {
    if (expandOpen && dropExpand) onExpandOpenChange?.(false);
  }, [expandOpen, dropExpand, onExpandOpenChange]);

  if (!src) {
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
            {}
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
          {}
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
