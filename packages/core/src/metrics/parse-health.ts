/**
 * Parse-health metrics — in-memory counters for R6 block-level fallback,
 * R13 y-prosemirror schema-throw substitution, and `parseWithFallback`
 * whole-doc fallback.
 *
 * Two channels:
 *   - Structured console.warn per event (developer-facing)
 *   - Aggregate counters exposed via GET /api/metrics/parse-health (test + ops)
 *
 * Deliberately NOT a Y.Map — server memory, lost on restart. Parse events don't
 * need CRDT convergence (each client re-parses independently).
 *
 * ## ypsMismatch wiring (CJS ↔ ESM bridge)
 *
 * The y-prosemirror patch lives in the package's CJS dist (and its ESM
 * sibling). Both runtimes execute in the same Node.js process, but CJS
 * `require()` cannot directly load this ESM module. The patch and this module
 * share state via `globalThis.__okYpsCounters` — the standard cross-module
 * mechanism for instrumentation that crosses module-system boundaries. Both
 * the patch and `getParseHealth()` read/write the same object reference, so
 * `/api/metrics/parse-health` reports real values from both surfaces.
 */

interface YpsCounters {
  block: number;
  inline: number;
}

interface YpsCountersHost {
  __okYpsCounters?: YpsCounters;
}

/**
 * Cross-module-system counter store for ypsMismatch. Initialized lazily on
 * first access so import order between this module and the patched CJS does
 * not matter — whichever runs first creates the object, the other binds to
 * the same reference via globalThis.
 *
 * The cast to YpsCountersHost is a structural-typing lookup, not a global
 * declaration — keeps the interaction with globalThis localized to this
 * helper rather than augmenting the global namespace.
 */
function ypsCounters(): YpsCounters {
  const host = globalThis as YpsCountersHost;
  host.__okYpsCounters ||= { block: 0, inline: 0 };
  return host.__okYpsCounters;
}

export interface ParseHealthMetrics {
  /**
   * `wholeDoc` counts STRUCTURAL whole-doc fallbacks only — content that
   * genuinely cannot degrade better than raw text (depth cap, recovery
   * failure, position-less error with no per-block win). `wholeDocBudget`
   * counts ABORTS from the defense-in-depth wall-clock/call budget in
   * `parseWithFallback` — an environmental signal (CPU contention, hostile
   * input volume), not a content-health signal. Keep them split: tests and
   * alerts that assert "no whole-doc fallback" on a fixed corpus must not
   * trip when a loaded machine crosses the time budget on content that
   * parses fine when idle.
   */
  parseFallback: { blockLevel: number; wholeDoc: number; wholeDocBudget: number };
  ypsMismatch: { block: number; inline: number };
  /**
   * Render-layer failure counters. Per-registered-descriptor + wildcard.
   * Client-only today: the events fire inside `JsxComponentView`'s
   * `ComponentErrorBoundary.componentDidCatch` and its post-error rAF
   * auto-convert; React components don't render on the server. The server
   * endpoint's row therefore stays at zero for these — but the shape is
   * wired so DevTools and unit tests can inspect the client's running
   * totals uniformly, and a future client→server push path exposes
   * aggregate fleet-wide counts through the same response shape.
   *
   * Labels are the registered descriptor name (`'Callout'`, `'Card'`, …)
   * or the literal `'wildcard'`. User-authored MDX names never land as
   * a label — the raw name is kept in a separate `rawComponentName`
   * field on the per-event `console.warn` payload (see
   * `JsxComponentView.tsx`'s emission sites) so telemetry aggregation
   * cannot explode cardinality.
   */
  jsxRenderFailure: Record<string, number>;
  jsxAutoConvertFailed: Record<string, number>;
  /**
   * Successful auto-convert counter — keyed the same way as
   * `jsxAutoConvertFailed`. Publishing both lets operators compute a
   * success rate (`succeeded / (succeeded + failed)`) rather than reading
   * the absolute failure count against an unknown denominator.
   */
  jsxAutoConvertSucceeded: Record<string, number>;
  /**
   * Dangerous-prop drops from `sanitizeComponentProps`. Keyed by lowercased
   * prop name (`'onclick'`, `'dangerouslysetinnerhtml'`, `'href'`, …).
   * Cardinality is bounded — React's `on*` namespace is ~80 names plus a
   * handful of explicit internals; URL-valued props share the `URL_PROP_NAMES`
   * set. Elevated above `console.debug` because drop volume is the primary
   * signal for targeted XSS probes against the editor surface.
   */
  jsxPropDropped: Record<string, number>;
  /**
   * Move-up / Move-down click failures on the JSX chrome bar. Keyed by
   * direction (`'up'` or `'down'`). Elevates the structured
   * `jsx-component-move-failed` event from a one-off log line to an
   * aggregable counter so ops can compute a click-failure rate against
   * total move clicks (denominator: client-side click telemetry, not in
   * scope here). Cardinality bounded to {up, down}.
   */
  jsxMoveFailed: Record<string, number>;
  /**
   * Stuck-state recovery affordance failures. Keyed by
   * registered descriptor name or `'wildcard'` — same low-cardinality
   * shape as `jsxRenderFailure`. Elevates the structured
   * `jsx-component-stuck-copy-failed` and `jsx-component-stuck-delete-failed`
   * events from one-off log lines to aggregable counters. The denominator
   * (number of stuck-state placeholders shown) is the existing
   * `jsxAutoConvertFailed` counter — together they let ops compute the
   * recovery success rate from the highest-friction UX moment.
   */
  jsxStuckCopyFailed: Record<string, number>;
  jsxStuckDeleteFailed: Record<string, number>;
  /**
   * Defensive-dispatch failure counters added for the JSX selection / prop
   * panel UX bundle. Each pairs with a structured `console.warn` event for
   * human-debug visibility and elevates that event to an aggregable counter
   * so ops can compute failure rates against a denominator. All three are
   * keyed by a low-cardinality label per the same contract as
   * `jsxRenderFailure` — a registered descriptor name or `'wildcard'` for
   * the JsxComponentView sites, and a PM node type name for the grip site.
   *
   * Denominators (out of scope for this counter set): the click telemetry
   * that fires the underlying dispatch. Ops can join against existing
   * counts of slash-inserts, popover open/close, and grip clicks if those
   * land later.
   */
  jsxPopoverCloseRestoreFailed: Record<string, number>;
  jsxKeyboardDeleteFailed: Record<string, number>;
  blockGripClickSelectFailed: Record<string, number>;
  /**
   * Bare-arrow auto-NodeSelect dispatch failures from the keyboard-nav L0
   * handler. Keyed by direction (`'up'` / `'down'` / `'left'` / `'right'`)
   * for low cardinality. Pairs with the structured
   * `jsx-component-arrow-node-select-failed` event in `block-ux/keyboard-nav.ts`. The
   * common cause is a concurrent CRDT edit that shifts positions between
   * gate-resolution and dispatch — the handler catches `RangeError`, falls
   * back to no-op, and increments here so ops can spot a high failure rate.
   */
  jsxArrowNodeSelectFailed: Record<string, number>;
}

const metrics: {
  parseFallback: { blockLevel: number; wholeDoc: number; wholeDocBudget: number };
  jsxRenderFailure: Record<string, number>;
  jsxAutoConvertFailed: Record<string, number>;
  jsxAutoConvertSucceeded: Record<string, number>;
  jsxPropDropped: Record<string, number>;
  jsxMoveFailed: Record<string, number>;
  jsxStuckCopyFailed: Record<string, number>;
  jsxStuckDeleteFailed: Record<string, number>;
  jsxPopoverCloseRestoreFailed: Record<string, number>;
  jsxKeyboardDeleteFailed: Record<string, number>;
  blockGripClickSelectFailed: Record<string, number>;
  jsxArrowNodeSelectFailed: Record<string, number>;
} = {
  parseFallback: { blockLevel: 0, wholeDoc: 0, wholeDocBudget: 0 },
  jsxRenderFailure: {},
  jsxAutoConvertFailed: {},
  jsxAutoConvertSucceeded: {},
  jsxPropDropped: {},
  jsxMoveFailed: {},
  jsxStuckCopyFailed: {},
  jsxStuckDeleteFailed: {},
  jsxPopoverCloseRestoreFailed: {},
  jsxKeyboardDeleteFailed: {},
  blockGripClickSelectFailed: {},
  jsxArrowNodeSelectFailed: {},
};

export function incrementBlockFallback(): void {
  metrics.parseFallback.blockLevel++;
}

export function incrementWholeDocFallback(): void {
  metrics.parseFallback.wholeDoc++;
}

/**
 * Budget-abort flavor of {@link incrementWholeDocFallback} — see the
 * `ParseHealthMetrics.parseFallback` docblock for why the two are split.
 */
export function incrementWholeDocBudgetFallback(): void {
  metrics.parseFallback.wholeDocBudget++;
}

/**
 * Increment the counter for a jsx-render-failure emission. `component` is
 * the clamped, low-cardinality label — a stable surface identifier shared
 * across every render-throw site that feeds this counter (registered JSX
 * descriptor names, the literal string `'wildcard'`, and stable surface
 * names like `'mathInline'` or `'sidebarSearchPill'`). Callers MUST NOT
 * pass user-authored MDX names; those belong in the per-event payload's
 * `rawComponentName` field, not in the counter key.
 */
export function incrementJsxRenderFailure(component: string): void {
  metrics.jsxRenderFailure[component] = (metrics.jsxRenderFailure[component] ?? 0) + 1;
}

/** See {@link incrementJsxRenderFailure} — same cardinality contract. */
export function incrementJsxAutoConvertFailed(component: string): void {
  metrics.jsxAutoConvertFailed[component] = (metrics.jsxAutoConvertFailed[component] ?? 0) + 1;
}

/** See {@link incrementJsxRenderFailure} — same cardinality contract. */
export function incrementJsxAutoConvertSucceeded(component: string): void {
  metrics.jsxAutoConvertSucceeded[component] =
    (metrics.jsxAutoConvertSucceeded[component] ?? 0) + 1;
}

/**
 * Increment the dangerous-prop drop counter. `propName` MUST be lowercased
 * (matches the shape in `DANGEROUS_PROP_NAMES` / `URL_PROP_NAMES`) so aggregation
 * across React camelCase (`onClick`) and HTML lowercase (`onclick`) collapses to
 * a single row.
 */
export function incrementJsxPropDropped(propName: string): void {
  metrics.jsxPropDropped[propName] = (metrics.jsxPropDropped[propName] ?? 0) + 1;
}

/**
 * Increment the JSX chrome move-failed counter. `direction`
 * is the bounded set `'up'` or `'down'`; passing arbitrary strings is a
 * caller bug. Pairs with the structured `jsx-component-move-failed`
 * `console.warn` event in `JsxComponentView` for human-debug visibility.
 */
export function incrementJsxMoveFailed(direction: 'up' | 'down'): void {
  metrics.jsxMoveFailed[direction] = (metrics.jsxMoveFailed[direction] ?? 0) + 1;
}

/**
 * Increment the stuck-state Copy-source failure counter.
 * Same low-cardinality contract as {@link incrementJsxRenderFailure} —
 * `component` is a registered descriptor name or the literal `'wildcard'`.
 */
export function incrementJsxStuckCopyFailed(component: string): void {
  metrics.jsxStuckCopyFailed[component] = (metrics.jsxStuckCopyFailed[component] ?? 0) + 1;
}

/** See {@link incrementJsxStuckCopyFailed} — same low-cardinality contract. */
export function incrementJsxStuckDeleteFailed(component: string): void {
  metrics.jsxStuckDeleteFailed[component] = (metrics.jsxStuckDeleteFailed[component] ?? 0) + 1;
}

/**
 * Defensive-dispatch failure counters for the JSX selection / prop panel
 * UX bundle. Same low-cardinality contract as {@link incrementJsxRenderFailure}:
 * `component` is a registered descriptor name or `'wildcard'`. Pair with
 * the structured `jsx-component-popover-close-restore-failed` and
 * `jsx-component-keyboard-delete-failed` `console.warn` events.
 */
export function incrementJsxPopoverCloseRestoreFailed(component: string): void {
  metrics.jsxPopoverCloseRestoreFailed[component] =
    (metrics.jsxPopoverCloseRestoreFailed[component] ?? 0) + 1;
}

/** See {@link incrementJsxPopoverCloseRestoreFailed} — same contract. */
export function incrementJsxKeyboardDeleteFailed(component: string): void {
  metrics.jsxKeyboardDeleteFailed[component] =
    (metrics.jsxKeyboardDeleteFailed[component] ?? 0) + 1;
}

/**
 * Grip-click NodeSelection dispatch failure counter. `nodeType` is the
 * ProseMirror node-type name (`'jsxComponent'`, `'paragraph'`, `'heading'`,
 * …) — bounded by the editor schema, so cardinality stays low. Pairs with
 * the structured `block-grip-click-select-failed` event in
 * `drag-handle.ts`.
 */
export function incrementBlockGripClickSelectFailed(nodeType: string): void {
  metrics.blockGripClickSelectFailed[nodeType] =
    (metrics.blockGripClickSelectFailed[nodeType] ?? 0) + 1;
}

/**
 * Bare-arrow auto-NodeSelect dispatch failure counter. `direction` is the
 * bounded set `'up' | 'down' | 'left' | 'right'`; passing arbitrary strings
 * is a caller bug. Pairs with the structured `jsx-component-arrow-node-select-failed`
 * `console.warn` event in `block-ux/keyboard-nav.ts` for human-debug
 * visibility — the common cause is a concurrent CRDT edit that shifts
 * positions mid-dispatch (`NodeSelection.create` throws `RangeError`).
 */
export function incrementJsxArrowNodeSelectFailed(
  direction: 'up' | 'down' | 'left' | 'right',
): void {
  metrics.jsxArrowNodeSelectFailed[direction] =
    (metrics.jsxArrowNodeSelectFailed[direction] ?? 0) + 1;
}

/**
 * Increment ypsMismatch.block counter.
 *
 * Reads through globalThis so test code and the y-prosemirror CJS patch share
 * one counter store. The patch increments via `globalThis.__okYpsCounters.block++`
 * directly — this exported helper is for ESM-side test seeding only.
 */
export function incrementYpsMismatchBlock(): void {
  ypsCounters().block++;
}

/** See {@link incrementYpsMismatchBlock} — same globalThis-shared store. */
export function incrementYpsMismatchInline(): void {
  ypsCounters().inline++;
}

export function getParseHealth(): ParseHealthMetrics {
  const yps = ypsCounters();
  return {
    parseFallback: { ...metrics.parseFallback },
    ypsMismatch: { block: yps.block, inline: yps.inline },
    jsxRenderFailure: { ...metrics.jsxRenderFailure },
    jsxAutoConvertFailed: { ...metrics.jsxAutoConvertFailed },
    jsxAutoConvertSucceeded: { ...metrics.jsxAutoConvertSucceeded },
    jsxPropDropped: { ...metrics.jsxPropDropped },
    jsxMoveFailed: { ...metrics.jsxMoveFailed },
    jsxStuckCopyFailed: { ...metrics.jsxStuckCopyFailed },
    jsxStuckDeleteFailed: { ...metrics.jsxStuckDeleteFailed },
    jsxPopoverCloseRestoreFailed: { ...metrics.jsxPopoverCloseRestoreFailed },
    jsxKeyboardDeleteFailed: { ...metrics.jsxKeyboardDeleteFailed },
    blockGripClickSelectFailed: { ...metrics.blockGripClickSelectFailed },
    jsxArrowNodeSelectFailed: { ...metrics.jsxArrowNodeSelectFailed },
  };
}

export function resetParseHealth(): void {
  metrics.parseFallback.blockLevel = 0;
  metrics.parseFallback.wholeDoc = 0;
  metrics.parseFallback.wholeDocBudget = 0;
  for (const k of Object.keys(metrics.jsxRenderFailure)) delete metrics.jsxRenderFailure[k];
  for (const k of Object.keys(metrics.jsxAutoConvertFailed)) delete metrics.jsxAutoConvertFailed[k];
  for (const k of Object.keys(metrics.jsxAutoConvertSucceeded))
    delete metrics.jsxAutoConvertSucceeded[k];
  for (const k of Object.keys(metrics.jsxPropDropped)) delete metrics.jsxPropDropped[k];
  for (const k of Object.keys(metrics.jsxMoveFailed)) delete metrics.jsxMoveFailed[k];
  for (const k of Object.keys(metrics.jsxStuckCopyFailed)) delete metrics.jsxStuckCopyFailed[k];
  for (const k of Object.keys(metrics.jsxStuckDeleteFailed)) delete metrics.jsxStuckDeleteFailed[k];
  for (const k of Object.keys(metrics.jsxPopoverCloseRestoreFailed))
    delete metrics.jsxPopoverCloseRestoreFailed[k];
  for (const k of Object.keys(metrics.jsxKeyboardDeleteFailed))
    delete metrics.jsxKeyboardDeleteFailed[k];
  for (const k of Object.keys(metrics.blockGripClickSelectFailed))
    delete metrics.blockGripClickSelectFailed[k];
  for (const k of Object.keys(metrics.jsxArrowNodeSelectFailed))
    delete metrics.jsxArrowNodeSelectFailed[k];
  const yps = ypsCounters();
  yps.block = 0;
  yps.inline = 0;
}
