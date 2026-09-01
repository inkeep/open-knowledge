import { Trans, useLingui } from '@lingui/react/macro';
import type { PanzoomObject } from '@panzoom/panzoom';
import type { MermaidWysiwygEditor } from '@visimer/core';
import type { MermaidCanvasView } from '@visimer/dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Maximize2,
  RefreshCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { type ComponentProps, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { createRetryingLoader } from '@/lib/retrying-loader.ts';
import { cn } from '@/lib/utils.ts';
import { useJsxComponentHost } from './jsx-host-context.tsx';
import { useAppColorMode } from './use-app-color-mode.ts';

export interface MermaidSourceBinding {
  canEdit: boolean;
  commitChart: (next: string) => void;
}

interface MermaidProps {
  chart?: string;
  className?: string;
  editBinding?: MermaidSourceBinding;
  onExpand?: () => void;
}

interface RenderState {
  status: 'rendering' | 'ready' | 'error';
  error: string;
}

const MERMAID_ZOOM_MIN = 0.5;
const MERMAID_ZOOM_MAX = 4;
const MERMAID_ZOOM_STEP = 0.25;

export function compensatedMaxScale(paintedWidth: number, viewBoxWidth: number): number {
  if (viewBoxWidth <= 0 || paintedWidth <= 0) return MERMAID_ZOOM_MAX;
  const displayScale = paintedWidth / viewBoxWidth;
  return Math.max(MERMAID_ZOOM_MAX, MERMAID_ZOOM_MAX / displayScale);
}

const LIGHTBOX_VIEW_BINDING: MermaidSourceBinding = {
  canEdit: false,
  commitChart: () => {},
};

const MERMAID_PAN_STEP = 48;
const MERMAID_PAN_ANIMATE_MS = 200;
const MERMAID_PAN_EASING = 'ease-out';
const buttonProps: ComponentProps<typeof Button> = {
  type: 'button',
  size: 'icon-sm',
  variant: 'secondary',
  className: 'border-border',
};

const loadMermaid = createRetryingLoader(() => import('mermaid').then((mod) => mod.default));

const loadWysiwyg = createRetryingLoader(() =>
  Promise.all([import('@visimer/core'), import('@visimer/dom')]),
);

const MERMAID_DARK_THEME_VARIABLES = {
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  background: '#0b0b0d',
  primaryColor: '#1c1c1f',
  primaryTextColor: '#f5f5f7',
  primaryBorderColor: '#2a2a2e',
  secondaryColor: '#242427',
  secondaryTextColor: '#f5f5f7',
  secondaryBorderColor: '#2a2a2e',
  tertiaryColor: '#2c2c30',
  tertiaryTextColor: '#f5f5f7',
  tertiaryBorderColor: '#2a2a2e',
  mainBkg: '#1c1c1f',
  lineColor: '#5a5a63',
  textColor: '#f5f5f7',
  actorBkg: '#1c1c1f',
  actorBorder: '#2a2a2e',
  actorTextColor: '#f5f5f7',
  actorLineColor: '#4a4a52',
  signalColor: '#8b8b93',
  signalTextColor: '#a1a1a9',
  labelBoxBkgColor: '#1c1c1f',
  labelBoxBorderColor: '#4a4a52',
  labelTextColor: '#a1a1a9',
  loopTextColor: '#a1a1a9',
  nodeBorder: '#1c1c1f',
  clusterBkg: '#141416',
  clusterBorder: '#2a2a2e',
  defaultLinkColor: '#5a5a63',
  edgeLabelBackground: '#0b0b0d',
  titleColor: '#a1a1a9',
  noteBkgColor: '#c88a1e',
  noteTextColor: '#ffffff',
  noteBorderColor: '#c88a1e',
  activationBkgColor: '#2c2c30',
  activationBorderColor: '#3a3a40',
} as const;

function mermaidConfigFor(colorMode: 'light' | 'dark'): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: colorMode === 'dark' ? 'dark' : 'default',
    themeVariables: colorMode === 'dark' ? MERMAID_DARK_THEME_VARIABLES : undefined,
    suppressErrorRendering: true,
  };
}

export const loadPanzoom = createRetryingLoader(() =>
  import('@panzoom/panzoom').then((mod) => mod.default),
);

const CANVAS_CONTAINED_EVENTS = [
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'pointerdown',
  'pointerup',
  'keydown',
  'keyup',
  'keypress',
] as const;

export function MermaidView({ chart = '', className, editBinding, onExpand }: MermaidProps) {
  const { t } = useLingui();
  const [state, setState] = useState<RenderState>({ status: 'rendering', error: '' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const colorMode = useAppColorMode();
  const host = useJsxComponentHost();
  const canEdit = editBinding ? editBinding.canEdit : (host?.editor.isEditable ?? false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef(host);
  useLayoutEffect(() => {
    hostRef.current = host;
  }, [host]);
  const editBindingRef = useRef(editBinding);
  useLayoutEffect(() => {
    editBindingRef.current = editBinding;
  }, [editBinding]);
  const chartRef = useRef(chart);
  useLayoutEffect(() => {
    chartRef.current = chart;
  }, [chart]);
  const canEditRef = useRef(canEdit);
  useLayoutEffect(() => {
    canEditRef.current = canEdit;
  }, [canEdit]);
  const colorModeRef = useRef(colorMode);
  useLayoutEffect(() => {
    colorModeRef.current = colorMode;
  }, [colorMode]);
  const editorRef = useRef<MermaidWysiwygEditor | null>(null);
  const viewRef = useRef<MermaidCanvasView | null>(null);
  const panzoomRef = useRef<PanzoomObject | null>(null);
  const [panzoomFailed, setPanzoomFailed] = useState(false);
  const maxScaleObsRef = useRef<ResizeObserver | null>(null);
  const loadFailedRef = useRef(false);

  const hasChart = Boolean(chart.trim());

  useEffect(() => {
    void loadAttempt;
    if (!hasChart) return;
    let disposed = false;
    let view: MermaidCanvasView | null = null;
    const offs: Array<() => void> = [];
    let hasRendered = false;
    setState({ status: 'rendering', error: '' });
    void loadPanzoom().catch(() => undefined);

    function commitChartSource(newChart: string): void {
      const binding = editBindingRef.current;
      if (binding) {
        binding.commitChart(newChart);
        return;
      }
      const h = hostRef.current;
      if (!h) return;
      const pos = h.getPos();
      if (typeof pos !== 'number') return;
      const node = h.editor.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'jsxComponent') return;
      const currentProps = (node.attrs.props as Record<string, unknown>) ?? {};
      try {
        h.editor.view.dispatch(
          h.editor.state.tr.setNodeMarkup(pos, null, {
            ...node.attrs,
            props: { ...currentProps, chart: newChart },
            sourceDirty: true,
          }),
        );
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
      }
    }

    function attachPanzoom(): void {
      const svgElement = canvasRef.current?.querySelector<SVGElement>('svg');
      const previous = panzoomRef.current;
      panzoomRef.current = null;
      previous?.destroy();
      if (svgElement?.namespaceURI !== 'http://www.w3.org/2000/svg') return;
      const viewBox = (svgElement as Partial<SVGSVGElement>).viewBox?.baseVal;
      if (viewBox && viewBox.width > 0) svgElement.style.maxWidth = `${viewBox.width}px`;
      loadPanzoom()
        .then((Panzoom) => {
          if (disposed) return;
          if (canvasRef.current?.querySelector('svg') !== svgElement) return;
          panzoomRef.current?.destroy();
          const panzoom = Panzoom(svgElement, {
            canvas: true,
            cursor: 'default',
            maxScale: MERMAID_ZOOM_MAX,
            minScale: MERMAID_ZOOM_MIN,
            noBind: true,
            step: MERMAID_ZOOM_STEP,
            touchAction: 'auto',
          });
          panzoomRef.current = panzoom;
          setPanzoomFailed(false);
          try {
            maxScaleObsRef.current?.disconnect();
            maxScaleObsRef.current = null;
            if (viewBox && viewBox.width > 0) {
              const vbW = viewBox.width;
              const applyMaxScale = (width: number) => {
                if (disposed || panzoomRef.current !== panzoom) return;
                if (width <= 0) return;
                try {
                  panzoom.setOptions({
                    maxScale: compensatedMaxScale(width, vbW),
                  });
                } catch (err) {
                  console.warn('[Mermaid] maxScale compensation failed:', err);
                }
              };
              applyMaxScale(svgElement.getBoundingClientRect().width);
              if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver((entries) => {
                  const width = entries[0]?.contentRect.width ?? 0;
                  applyMaxScale(width);
                });
                ro.observe(svgElement);
                maxScaleObsRef.current = ro;
              }
            }
          } catch (err) {
            console.warn('[Mermaid] maxScale observer setup failed:', err);
          }
        })
        .catch((err) => {
          console.warn('[Mermaid] panzoom setup failed:', err);
          if (!disposed) setPanzoomFailed(true);
        });
    }

    if (editBindingRef.current) {
      const scrollContainer = canvasRef.current;
      if (scrollContainer) {
        const onWheel = (e: WheelEvent) => {
          const pz = panzoomRef.current;
          if (!pz) return;
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            pz.zoomWithWheel(e);
            return;
          }
          e.preventDefault();
          const scale = typeof pz.getScale === 'function' ? pz.getScale() : 1;
          const denom = scale > 0 ? scale : 1;
          pz.pan(-e.deltaX / denom, -e.deltaY / denom, { relative: true });
        };
        scrollContainer.addEventListener('wheel', onWheel, { passive: false });
        offs.push(() => scrollContainer.removeEventListener('wheel', onWheel));
      }
    }

    Promise.all([loadMermaid(), loadWysiwyg()])
      .then(([mermaid, [core, dom]]) => {
        const container = canvasRef.current;
        if (disposed || !container) return;
        const editor = new core.MermaidWysiwygEditor({ code: chartRef.current });
        view = new dom.MermaidCanvasView({
          editor,
          container,
          mermaid,
          mermaidConfig: mermaidConfigFor(colorModeRef.current),
          readOnly: !canEditRef.current,
          accentColor: 'var(--ring)',
        });
        editorRef.current = editor;
        viewRef.current = view;
        offs.push(
          editor.on('change', ({ code, origin }) => {
            if (origin === 'external') return;
            commitChartSource(code);
          }),
          view.on('render', ({ ok, error }) => {
            if (disposed) return;
            if (ok) {
              hasRendered = true;
              setState({ status: 'ready', error: '' });
              attachPanzoom();
            } else if (!hasRendered) {
              setState({ status: 'error', error: error ?? '' });
            }
          }),
        );
      })
      .catch((err) => {
        if (disposed) return;
        loadFailedRef.current = true;
        const msg = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', error: msg });
      });

    return () => {
      disposed = true;
      for (const off of offs) off();
      panzoomRef.current?.destroy();
      panzoomRef.current = null;
      maxScaleObsRef.current?.disconnect();
      maxScaleObsRef.current = null;
      view?.destroy();
      editorRef.current = null;
      viewRef.current = null;
    };
  }, [hasChart, loadAttempt]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && chart !== editor.code) {
      editor.setCode(chart, 'external');
    } else if (!editorRef.current && loadFailedRef.current && chart.trim()) {
      loadFailedRef.current = false;
      setLoadAttempt((n) => n + 1);
    }
  }, [chart]);

  useEffect(() => {
    viewRef.current?.setReadOnly(!canEdit);
  }, [canEdit]);

  useEffect(() => {
    viewRef.current?.setMermaidConfig(mermaidConfigFor(colorMode));
  }, [colorMode]);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container || !canEdit || !hasChart) return;
    const stop = (e: Event) => e.stopPropagation();
    for (const type of CANVAS_CONTAINED_EVENTS) container.addEventListener(type, stop);
    return () => {
      for (const type of CANVAS_CONTAINED_EVENTS) container.removeEventListener(type, stop);
    };
  }, [canEdit, hasChart]);

  if (!hasChart) {
    return (
      <div
        className={cn(
          'mermaid mermaid-placeholder flex min-h-16 w-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/10 px-3 py-6 text-sm text-muted-foreground',
          className,
        )}
        data-component-type="mermaid"
      >
        <span className="mermaid-empty">
          <Trans>Empty diagram</Trans>
        </span>
      </div>
    );
  }

  const showCanvas = state.status === 'ready';

  return (
    <div
      className={cn(
        'mermaid',
        showCanvas &&
          'mermaid-ready flex h-full min-h-64 w-full overflow-hidden rounded-md border border-border/60 bg-background',
        state.status === 'error' && 'mermaid-error',
        state.status === 'rendering' && 'mermaid-rendering',
        className,
      )}
      data-component-type="mermaid"
      title={state.status === 'error' ? state.error : undefined}
    >
      {state.status === 'error' && (
        <>
          <div
            role="alert"
            className="mermaid-error-message mb-2 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
          >
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden />
            <div className="min-w-0">
              <div className="font-medium">
                <Trans>Mermaid diagram failed to render.</Trans>
              </div>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] opacity-90">
                {state.error}
              </pre>
            </div>
          </div>
          {}
          <pre className="mermaid-error-source">{chart}</pre>
        </>
      )}
      {}
      <div
        contentEditable={false}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-muted/20',
          showCanvas ? 'flex' : 'hidden',
        )}
      >
        <div ref={canvasRef} className="ok-mermaid-svg flex min-h-0 flex-1" />
        {showCanvas && (
          <PanzoomControls
            panzoomRef={panzoomRef}
            label={t`Mermaid diagram controls`}
            testId="mermaid-actions"
            onExpand={onExpand}
            unavailable={panzoomFailed}
          />
        )}
      </div>
    </div>
  );
}

export function MermaidLightbox({
  chart,
  open,
  onOpenChange,
}: {
  chart: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[calc(100dvh-5rem)] w-[calc(100dvw-5rem)] max-w-none gap-0 p-2 pt-10 duration-200 sm:max-w-none"
        style={{ '--tw-enter-scale': '0.92', '--tw-exit-scale': '0.92' } as React.CSSProperties}
      >
        <DialogTitle className="sr-only">{t`Mermaid diagram`}</DialogTitle>
        {}
        <span className="absolute top-2 left-3 flex h-7 items-center text-xs text-muted-foreground">
          {t`View only`}
        </span>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <MermaidView chart={chart} editBinding={LIGHTBOX_VIEW_BINDING} className="min-h-0" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PanzoomControls({
  panzoomRef,
  label,
  testId,
  onExpand,
  unavailable,
}: {
  panzoomRef: React.RefObject<PanzoomObject | null>;
  label: string;
  testId: string;
  onExpand?: () => void;
  unavailable?: boolean;
}) {
  const { t } = useLingui();
  const reducedMotion = useReducedMotion();
  const panButtonProps = { ...buttonProps, disabled: unavailable };
  const labels = {
    zoomIn: t`Zoom in`,
    zoomOut: t`Zoom out`,
    reset: t`Reset view`,
    panUp: t`Pan up`,
    panDown: t`Pan down`,
    panLeft: t`Pan left`,
    panRight: t`Pan right`,
    expand: t`Expand diagram`,
    toolbar: label,
  } as const;

  const panBy = (x: number, y: number) => {
    panzoomRef.current?.pan(x, y, {
      animate: !reducedMotion,
      duration: MERMAID_PAN_ANIMATE_MS,
      easing: MERMAID_PAN_EASING,
      relative: true,
    });
  };

  return (
    <div
      className="absolute right-3 bottom-3 grid grid-cols-3 gap-1"
      data-testid={testId}
      role="toolbar"
      aria-label={labels.toolbar}
    >
      {onExpand ? (
        <Button
          {...buttonProps}
          title={labels.expand}
          aria-label={labels.expand}
          onClick={onExpand}
        >
          <Maximize2 className="size-4" aria-hidden="true" />
        </Button>
      ) : (
        <span aria-hidden="true" />
      )}
      <Button
        {...panButtonProps}
        title={labels.panUp}
        aria-label={labels.panUp}
        onClick={() => panBy(0, MERMAID_PAN_STEP)}
      >
        <ArrowUp className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...panButtonProps}
        title={labels.zoomIn}
        aria-label={labels.zoomIn}
        onClick={() => panzoomRef.current?.zoomIn()}
      >
        <ZoomIn className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...panButtonProps}
        title={labels.panLeft}
        aria-label={labels.panLeft}
        onClick={() => panBy(MERMAID_PAN_STEP, 0)}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...panButtonProps}
        title={labels.reset}
        aria-label={labels.reset}
        onClick={() => panzoomRef.current?.reset()}
      >
        <RefreshCcw className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...panButtonProps}
        title={labels.panRight}
        aria-label={labels.panRight}
        onClick={() => panBy(-MERMAID_PAN_STEP, 0)}
      >
        <ArrowRight className="size-4" aria-hidden="true" />
      </Button>
      <span aria-hidden="true" />
      <Button
        {...panButtonProps}
        title={labels.panDown}
        aria-label={labels.panDown}
        onClick={() => panBy(0, -MERMAID_PAN_STEP)}
      >
        <ArrowDown className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...panButtonProps}
        title={labels.zoomOut}
        aria-label={labels.zoomOut}
        onClick={() => panzoomRef.current?.zoomOut()}
      >
        <ZoomOut className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
