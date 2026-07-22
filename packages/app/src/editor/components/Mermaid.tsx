/**
 * MermaidView — WYSIWYG renderer for the canonical `<Mermaid>` block descriptor.
 *
 * Mermaid is browser-only (no first-party SSR per upstream issue #3650),
 * which fits OK's Vite + React 19 client perfectly. The library is lazy-
 * imported on first mount to keep the editor's first-load JS unaffected
 * for documents without diagrams; cost at first diagram is ~150 KB
 * gzipped (entry ~11 KB + lazy diagram-type chunks 24-45 KB each).
 *
 * Rendering + editing are delegated to `visimer`
 * (`@visimer/core` + `@visimer/dom`): the canvas view
 * renders through our own lazy `mermaid` instance (full fidelity, same
 * theming as before), correlates the SVG back to source entities, and
 * overlays interaction — click-select with a per-entity action popover
 * (shape / edge-type / color pickers, delete, …), double-click in-place
 * label editing, drag-to-connect, sequence-message drag-reorder. Every
 * gesture compiles to a minimal text edit against the chart source,
 * which we commit through the same write paths the old inline editor
 * used. There is deliberately NO external editing toolbar — all edit
 * affordances live on the diagram itself.
 *
 * Source-of-truth flow: the `chart` prop is canonical. Canvas gestures
 * mutate the package editor's internal code and surface through its
 * `change` event (origin !== 'external'), which we commit outward
 * (JSX-host `setNodeMarkup` or the standalone-doc `editBinding`). Remote
 * CRDT edits arrive as a new `chart` prop and re-enter the package via
 * `setCode(chart, 'external')`, which re-renders without echoing back.
 *
 * Why the canvas can host contenteditable labels inside ProseMirror's
 * tree (the old implementation portalled inputs to `document.body`):
 * PM's DOMObserver only reacts to selection changes while the PM view
 * itself has focus (`hasFocusAndSelection`); the canvas moves focus to
 * its own container / label, so PM stays out. Child-list/character
 * mutations inside the NodeView body are ignored by TipTap's default
 * `ignoreMutation` (they're outside the contentDOM). The remaining
 * hazard — PM's own event handlers reacting to canvas clicks/keys — is
 * closed by the bubble-phase stopPropagation guard on the canvas
 * container below.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import type { default as PanZoomNS, PanzoomObject } from '@panzoom/panzoom';
import type { MermaidWysiwygEditor } from '@visimer/core';
import type { MermaidCanvasView } from '@visimer/dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RefreshCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { default as MermaidNS } from 'mermaid';
import { type ComponentProps, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils.ts';
import { useJsxComponentHost } from './jsx-host-context.tsx';

// MermaidFence descriptor declares a single `chart` prop. `id` and `theme`
// are absent because neither is expressible in ` ```mermaid ` fence syntax,
// and no production code path can thread them to this component (the
// promoter emits `{chart}` only). Re-adding either to this interface would
// create a parallel render-side surface that nothing reaches.
/**
 * Write binding for the chart source that backs WYSIWYG editing. Decouples
 * `MermaidView` from its edit host so the SAME canvas machinery serves two
 * surfaces: a codefenced ` ```mermaid ` fence (source lives on a TipTap
 * `jsxComponent` node) and a standalone `.mmd` doc (source is a CRDT
 * `Y.Text`). Reads flow the other way — the `chart` prop is pushed into the
 * canvas on every external change — so the binding only needs the commit
 * direction.
 */
export interface MermaidSourceBinding {
  canEdit: boolean;
  commitChart: (next: string) => void;
}

interface MermaidProps {
  chart?: string;
  className?: string;
  /**
   * When provided, WYSIWYG edits write back through this binding instead of
   * the JSX-component host (the standalone `.mmd` doc path). Absent for
   * codefenced fences, which derive the binding from `useJsxComponentHost()`.
   */
  editBinding?: MermaidSourceBinding;
}

interface RenderState {
  status: 'rendering' | 'ready' | 'error';
  error: string;
}

const MERMAID_ZOOM_MIN = 0.5;
const MERMAID_ZOOM_MAX = 4;
const MERMAID_ZOOM_STEP = 0.25;
const MERMAID_PAN_STEP = 48;
const buttonProps: ComponentProps<typeof Button> = {
  type: 'button',
  size: 'icon-sm',
  variant: 'secondary',
  className: 'border-border',
};

/**
 * One-time initialization. Called lazily on the first render attempt so
 * documents without Mermaid pay nothing. Subsequent calls are no-ops via
 * the module-level guard.
 */
let mermaidPromise: Promise<typeof MermaidNS> | null = null;
function loadMermaid() {
  mermaidPromise ||= import('mermaid')
    .then((mod) => mod.default)
    .catch((err) => {
      // Clear the cached rejection so the next mount can retry. Without
      // this, a transient network failure during the first import would
      // disable Mermaid for the entire session — every subsequent
      // `loadMermaid()` would resolve to the cached rejected promise.
      mermaidPromise = null;
      throw err;
    });
  return mermaidPromise;
}

let wysiwygPromise: Promise<
  [typeof import('@visimer/core'), typeof import('@visimer/dom')]
> | null = null;
function loadWysiwyg() {
  wysiwygPromise ||= Promise.all([import('@visimer/core'), import('@visimer/dom')]).catch((err) => {
    wysiwygPromise = null;
    throw err;
  });
  return wysiwygPromise;
}

/**
 * Read the app's active color mode from the `<html>` class list — the
 * theme provider sets `.dark` / `.light` on `documentElement`; that's
 * also what `useApplyConfigTheme` writes and what `useThemeBridge`
 * exposes. Falling back to `prefers-color-scheme` covers the pre-mount
 * / SSR window, but the class is authoritative once the app is up.
 */
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

/**
 * Mermaid's built-in `dark` theme covers node fills and text but leaves
 * sequence-diagram notes on a hardcoded pastel yellow (`#EDF2AE`) that
 * clashes on a dark background, and its actor-box colors read as bright
 * white. Override the load-bearing `themeVariables` so notes, actors,
 * labels, and arrow signals track the OK dark palette. Values are
 * intentionally plain hex — mermaid derives contrast colors from these
 * strings and CSS variables don't survive its color-math step.
 */
const MERMAID_DARK_THEME_VARIABLES = {
  // Match OK's mono-ish design language rather than mermaid's default
  // Trebuchet MS. The stack tracks common OS monospace faces used by
  // the surrounding editor UI.
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  // Nodes + primaries (flowchart cores, actor boxes).
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
  // Edges and connectors — muted grey. Mermaid's built-in `dark` theme
  // pins these near-white, which reads as a set of harsh white lines
  // stitched across a dark canvas; the reference styling uses a dim
  // grey for every non-content stroke.
  lineColor: '#5a5a63',
  textColor: '#f5f5f7',
  // Sequence-diagram actors + arrows.
  actorBkg: '#1c1c1f',
  actorBorder: '#2a2a2e',
  actorTextColor: '#f5f5f7',
  actorLineColor: '#4a4a52',
  signalColor: '#8b8b93',
  signalTextColor: '#a1a1a9',
  // alt / opt / loop group chrome — dashed borders + label pill.
  labelBoxBkgColor: '#1c1c1f',
  labelBoxBorderColor: '#4a4a52',
  labelTextColor: '#a1a1a9',
  loopTextColor: '#a1a1a9',
  // Flowchart-specific overrides. Mermaid's default `dark` theme paints
  // `.node rect` with a near-white border via `nodeBorder`; the
  // reference styling wants the node fill to read as a single dark
  // shape with no visible outline. Cluster (subgraph) fills track the
  // same tone so nested clusters read as tiers not colored boxes.
  nodeBorder: '#1c1c1f',
  clusterBkg: '#141416',
  clusterBorder: '#2a2a2e',
  defaultLinkColor: '#5a5a63',
  edgeLabelBackground: '#0b0b0d',
  titleColor: '#a1a1a9',
  // Sequence-diagram Note over/left of/right of. A bold amber solid
  // reads as an intentional callout on a dark canvas — matches the
  // reference styling far better than the muted brown from the first
  // pass here.
  noteBkgColor: '#c88a1e',
  noteTextColor: '#ffffff',
  noteBorderColor: '#c88a1e',
  // Activation (self-arrow) chrome.
  activationBkgColor: '#2c2c30',
  activationBorderColor: '#3a3a40',
} as const;

/**
 * Mermaid config for the canvas view. `MermaidCanvasView` owns the
 * `initialize` calls (at construction and via `setMermaidConfig` on
 * theme flips); this builder keeps the palette in one place.
 */
function mermaidConfigFor(colorMode: 'light' | 'dark'): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: colorMode === 'dark' ? 'dark' : 'default',
    themeVariables: colorMode === 'dark' ? MERMAID_DARK_THEME_VARIABLES : undefined,
    suppressErrorRendering: true,
  };
}

let panzoomPromise: Promise<typeof PanZoomNS> | null = null;
function loadPanzoom() {
  panzoomPromise ||= import('@panzoom/panzoom')
    .then((mod) => mod.default)
    .catch((err) => {
      panzoomPromise = null;
      throw err;
    });
  return panzoomPromise;
}

/**
 * Events that must never escape the canvas into ProseMirror while the
 * diagram is editable. The canvas owns selection (click), label editing
 * (dblclick + typing), entity deletion (Delete/Backspace), and its own
 * undo (mod+Z) — any of these reaching PM would double-handle: PM would
 * NodeSelect the block, delete the whole fence on Backspace, or run the
 * document-level undo alongside the canvas one.
 */
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

export function MermaidView({ chart = '', className, editBinding }: MermaidProps) {
  const [state, setState] = useState<RenderState>({ status: 'rendering', error: '' });
  // Bumped to re-run the canvas-creation effect after a lazy-import
  // failure so a later chart edit retries the load (the module-level
  // promise caches clear themselves on rejection).
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Track the app's color mode so mermaid's palette can flip with the
  // theme provider — reading it once at mount + observing the `<html>`
  // class list keeps SVG contrast aligned even when the user toggles
  // themes with a diagram already on screen.
  const [colorMode, setColorMode] = useState<'light' | 'dark'>(() => readDocumentColorMode());
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const doc = document.documentElement;
    const sync = () => {
      const next = readDocumentColorMode();
      setColorMode((prev) => (prev === next ? prev : next));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(doc, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  const host = useJsxComponentHost();
  // An explicit `editBinding` (standalone `.mmd` doc) wins; otherwise editing is
  // gated on the JSX host being editable (codefenced fence).
  const canEdit = editBinding ? editBinding.canEdit : (host?.editor.isEditable ?? false);
  const canvasRef = useRef<HTMLDivElement>(null);
  // `useJsxComponentHost()` returns a fresh object literal on every
  // parent render (JsxComponentView constructs `{editor, getPos, ...}`
  // inline), so putting `host` directly in a `useEffect` dep would
  // re-create the canvas on every unrelated re-render of the wrapper.
  // Keep effect deps stable and read the live host through a ref that
  // we sync on each render.
  const hostRef = useRef(host);
  // Sync the ref in a layout effect (runs after render, before paint).
  // Handlers can only fire after paint, so this is early enough to
  // always be current, and it avoids the "Cannot access refs during
  // render" React violation of assigning inside the render body.
  useLayoutEffect(() => {
    hostRef.current = host;
  }, [host]);
  // Same ref treatment for the optional standalone binding: the parent may
  // hand a fresh object each render, so read it live through the ref inside
  // handlers to keep the canvas-creation effect deps stable.
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
  const loadFailedRef = useRef(false);

  const hasChart = Boolean(chart.trim());

  // Create the package editor + canvas view once the lazy modules land.
  // Lives for the whole non-empty life of the component; chart / theme /
  // editability updates are applied by the sync effects below.
  useEffect(() => {
    // `loadAttempt` re-arms this effect after a failed lazy import (bumped by
    // the chart-sync effect below); its value is otherwise unused.
    void loadAttempt;
    if (!hasChart) return;
    let disposed = false;
    let view: MermaidCanvasView | null = null;
    const offs: Array<() => void> = [];
    let hasRendered = false;
    setState({ status: 'rendering', error: '' });
    void loadPanzoom().catch(() => undefined);

    // Write the new chart source back. Standalone binding wins; otherwise
    // dispatch one `setNodeMarkup` on the JSX-host `jsxComponent` node.
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
      // `setNodeMarkup` throws `RangeError` when `pos` has been
      // invalidated by a concurrent CRDT update between `getPos()` and
      // dispatch. That's a benign miss (the user's next mount resyncs
      // from the new canonical state) so we drop it. Any other
      // exception is a real bug and must surface.
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

    // (Re-)attach the pan/zoom controller to the freshly rendered SVG —
    // the canvas view replaces its SVG host's innerHTML on every render,
    // so the previous Panzoom target is gone.
    function attachPanzoom(): void {
      const svgElement = canvasRef.current?.querySelector<SVGElement>('svg');
      const previous = panzoomRef.current;
      panzoomRef.current = null;
      previous?.destroy();
      if (svgElement?.namespaceURI !== 'http://www.w3.org/2000/svg') return;
      // The package pins the SVG's inline max-width to 100%; restore
      // mermaid's own natural-width cap (the viewBox width) so small
      // diagrams don't upscale past their rendered size — matching how
      // the SVG string used to land verbatim. Structural check (not
      // `instanceof SVGSVGElement`) so DOM-emulated test substrates
      // without the SVG constructor globals stay on the happy path.
      const viewBox = (svgElement as Partial<SVGSVGElement>).viewBox?.baseVal;
      if (viewBox && viewBox.width > 0) svgElement.style.maxWidth = `${viewBox.width}px`;
      loadPanzoom()
        .then((Panzoom) => {
          if (disposed) return;
          // A newer render may have replaced the SVG while Panzoom loaded.
          if (canvasRef.current?.querySelector('svg') !== svgElement) return;
          panzoomRef.current?.destroy();
          panzoomRef.current = Panzoom(svgElement, {
            canvas: true,
            cursor: 'default',
            maxScale: MERMAID_ZOOM_MAX,
            minScale: MERMAID_ZOOM_MIN,
            noBind: true,
            step: MERMAID_ZOOM_STEP,
            touchAction: 'auto',
          });
        })
        .catch((err) => {
          console.warn('[Mermaid] panzoom setup failed:', err);
        });
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
            // 'external' marks our own prop-driven `setCode` round-trips;
            // everything else (canvas gestures, package history) is a user
            // edit that must land in the real source of truth.
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
              // Before the first successful render there is no diagram to
              // keep on screen — surface the full error chrome. After one,
              // the canvas keeps the last good SVG and shows the package's
              // compact error badge instead (error-tolerant mid-edit).
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
      view?.destroy();
      editorRef.current = null;
      viewRef.current = null;
    };
  }, [hasChart, loadAttempt]);

  // External chart updates (remote CRDT edits, source-mode typing) re-enter
  // the package editor without echoing back through the commit path.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && chart !== editor.code) {
      editor.setCode(chart, 'external');
    } else if (!editorRef.current && loadFailedRef.current && chart.trim()) {
      // The lazy import failed before a canvas existed — retry on the next
      // chart change (mirrors the old per-render retry behavior).
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

  // Keep every canvas interaction out of ProseMirror's reach while
  // editable. Bubble-phase on the container: the package's own handlers
  // (svg-level, and its container keydown) still run — stopPropagation
  // only severs the path UP into PM's editor DOM. Read-only surfaces
  // (file viewer, read-only docs) leave events alone so the block keeps
  // its normal NodeSelection behavior.
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
    // Reached in read-only render contexts and the edit-modal preview with an
    // empty draft. The editor's authoring path renders a click-to-edit
    // placeholder card upstream (JsxComponentView), so this stays passive and
    // non-interactive — but it MUST hold real height: a zero-height stub
    // collapses the block and clips the hover chrome (the sliver bug).
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
          cn(
            'mermaid-ready flex h-full min-h-64 w-full overflow-hidden rounded-md border border-border/60 bg-background',
            className,
          ),
        state.status === 'error' && 'mermaid-error',
        state.status === 'rendering' && 'mermaid-rendering',
      )}
      data-component-type="mermaid"
      title={state.status === 'error' ? state.error : undefined}
    >
      {state.status === 'error' && (
        // Error banner sits ABOVE the source — readers' eyes land on the
        // diagnosis first, then the offending code. The destructive-toned
        // chrome here mirrors `PropertyPanel`'s malformed-FM banner so the
        // same visual language signals "agent-visible error" across surfaces.
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
          {/* The chart source shows WHAT the author wrote so they can locate
              the offending line/column the parser message refers to. */}
          <pre className="mermaid-error-source">{chart}</pre>
        </>
      )}
      {/* The canvas stays mounted across error/rendering states so the
          package view (and any in-flight edit session) survives — a fixed
          source re-renders straight back to `ready` without a remount. */}
      <div
        contentEditable={false}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-muted/20',
          showCanvas ? 'flex' : 'hidden',
        )}
      >
        <div ref={canvasRef} className="ok-mermaid-svg flex min-h-0 flex-1" />
        {showCanvas && <MermaidViewControls panzoomRef={panzoomRef} />}
      </div>
    </div>
  );
}

function MermaidViewControls({
  panzoomRef,
}: {
  panzoomRef: React.RefObject<PanzoomObject | null>;
}) {
  const { t } = useLingui();
  const labels = {
    zoomIn: t`Zoom in`,
    zoomOut: t`Zoom out`,
    reset: t`Reset view`,
    panUp: t`Pan up`,
    panDown: t`Pan down`,
    panLeft: t`Pan left`,
    panRight: t`Pan right`,
    toolbar: t`Mermaid diagram controls`,
  } as const;

  const panBy = (x: number, y: number) => {
    panzoomRef.current?.pan(x, y, { relative: true });
  };

  return (
    <div
      className="absolute right-3 bottom-3 grid grid-cols-3 gap-1"
      data-testid="mermaid-actions"
      role="toolbar"
      aria-label={labels.toolbar}
    >
      <span aria-hidden="true" />
      <Button
        {...buttonProps}
        title={labels.panUp}
        aria-label={labels.panUp}
        onClick={() => panBy(0, -MERMAID_PAN_STEP)}
      >
        <ArrowUp className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...buttonProps}
        title={labels.zoomIn}
        aria-label={labels.zoomIn}
        onClick={() => panzoomRef.current?.zoomIn()}
      >
        <ZoomIn className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...buttonProps}
        title={labels.panLeft}
        aria-label={labels.panLeft}
        onClick={() => panBy(-MERMAID_PAN_STEP, 0)}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...buttonProps}
        title={labels.reset}
        aria-label={labels.reset}
        onClick={() => panzoomRef.current?.reset()}
      >
        <RefreshCcw className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...buttonProps}
        title={labels.panRight}
        aria-label={labels.panRight}
        onClick={() => panBy(MERMAID_PAN_STEP, 0)}
      >
        <ArrowRight className="size-4" aria-hidden="true" />
      </Button>
      <span aria-hidden="true" />
      <Button
        {...buttonProps}
        title={labels.panDown}
        aria-label={labels.panDown}
        onClick={() => panBy(0, MERMAID_PAN_STEP)}
      >
        <ArrowDown className="size-4" aria-hidden="true" />
      </Button>
      <Button
        {...buttonProps}
        title={labels.zoomOut}
        aria-label={labels.zoomOut}
        onClick={() => panzoomRef.current?.zoomOut()}
      >
        <ZoomOut className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
