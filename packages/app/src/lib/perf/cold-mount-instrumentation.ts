/**
 * Cold-mount instrumentation — prototype-level monkey-patches that emit
 * `ok/cold/*` perf marks around the synchronous cost centers of the
 * `<TiptapEditor>` cold-mount call chain on large docs.
 *
 * Wrapped entry points:
 *   - `Editor.prototype.mount`                → `ok/cold/editor-mount`
 *   - `Editor.prototype.createView`           → `ok/cold/editor-create-view`
 *   - `Editor.prototype.createNodeViews`      → `ok/cold/create-node-views`
 *   - `EditorView.prototype.updateState`      → `ok/cold/pm-update-state` (per call)
 *   - `EditorView.prototype.setProps`         → `ok/cold/pm-set-props` (per call)
 *   - `ProsemirrorBinding.prototype._forceRerender` → `ok/cold/force-rerender`
 *   - `PureEditorContent.prototype.init`      → `ok/cold/ec-init`
 *
 * Per-component extensions — gated by `instrumentationDisabled()` (PROD
 * short-circuit, same shape as `__okPerfCounters` elsewhere):
 *   - Per-NodeView-factory          → `ok/cold/nodeview-factory-{nodeType}` (per call)
 *   - Per-decoration-plugin         → `ok/cold/decoration-{key}` (per call)
 *   - appendChild → first paint     → `ok/cold/append-to-paint` (once per cold mount)
 *   - Per-extension lifecycle hooks → `ok/cold/ext-{name}-{hook}` via wrapExtensionsWithTiming
 *
 * Also installs a PerformanceObserver for `paint` entries that re-emits
 * first-paint / first-contentful-paint via marks so they land in the
 * collector's data stream alongside the monkey-patched spans.
 *
 * The patch is a DIAGNOSTIC artifact — called ONCE from `main.tsx` before
 * any editor constructs. Default DEV/test only; can also install in PROD
 * builds by setting `VITE_OK_PERF_INSTRUMENT=1` so ship-gate measurement can
 * re-baseline against the true user-visible attack surface (single source
 * of truth: `shouldInstallColdMountInstrumentation`). Per-component
 * extensions delegate to the same gate via `instrumentationDisabled()` so
 * accidental hot-path invocation in disabled-PROD is a no-op with zero
 * overhead.
 */

import { type AnyExtension, Editor } from '@tiptap/core';
import type { Plugin } from '@tiptap/pm/state';
import { EditorView, type NodeViewConstructor } from '@tiptap/pm/view';
import { PureEditorContent } from '@tiptap/react';
import { ProsemirrorBinding } from '@tiptap/y-tiptap';
import { mark } from './mark';

let installed = false;

/**
 * Wrap a prototype method to emit a perf mark per invocation.
 *
 * Contract:
 *   1. The wrapped function returns whatever the original returns, throws
 *      whatever the original throws. Verbatim.
 *   2. A timing mark is always emitted (success OR throw) so we can attribute
 *      cost on either path.
 *   3. The optional `propsBuilder` reads success-path state (e.g., `instance.view`,
 *      `instance.state`) to enrich the mark's props. **It is only invoked on
 *      the success path** — on a throw path, `propsBuilder` is skipped because
 *      the instance is in a partially-constructed state that may make state
 *      reads unsafe (e.g., TipTap's `editor.view` getter returns a throwing
 *      proxy when `editor.editorView` is null after a failed `createView`).
 *   4. Even on the success path, `propsBuilder` is wrapped in a try/catch.
 *      Any throw inside `propsBuilder` is converted to an `instrumentation-error`
 *      props field on the timing mark and SWALLOWED. Instrumentation must never
 *      hijack the original control flow — its job is to observe, not to crash.
 */
export function wrapMethod<T extends Record<string, unknown>>(
  target: T,
  key: keyof T & string,
  markName: string,
  propsBuilder?: (
    instance: T,
    result: unknown,
    start: number,
    durationMs: number,
  ) => Record<string, unknown>,
): void {
  const original = target[key] as unknown as (...args: unknown[]) => unknown;
  if (typeof original !== 'function') {
    // eslint-disable-next-line no-console -- diagnostic
    console.warn(`[cold-mount-instrumentation] target missing method "${key}"`);
    return;
  }
  const wrapped = function patched(this: T, ...args: unknown[]): unknown {
    const start = performance.now();
    let result: unknown;
    let succeeded = false;
    try {
      result = original.apply(this, args);
      succeeded = true;
      return result;
    } finally {
      const now = performance.now();
      const durationMs = now - start;
      let extraProps: Record<string, unknown> | undefined;
      if (succeeded && propsBuilder) {
        try {
          extraProps = propsBuilder(this, result, start, durationMs);
        } catch (err) {
          extraProps = {
            'instrumentation-error': err instanceof Error ? err.message : String(err),
          };
        }
      }
      try {
        mark(
          markName,
          { durationMs: Math.round(durationMs * 1000) / 1000, threw: !succeeded, ...extraProps },
          { startTime: start, duration: durationMs },
        );
      } catch {
        // mark() should never throw, but defense-in-depth: an instrumentation
        // bug must not propagate out of the wrapper and mask the original
        // throw (or hijack the original return value).
      }
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: prototype patch
  (target as any)[key] = wrapped;
}

interface EditorInstanceShape {
  options?: { element?: unknown };
  editorState?: { doc?: { nodeSize?: number; content?: { size?: number } } };
  view?: PmViewShape;
}

interface PmViewShape {
  state?: {
    doc?: { nodeSize?: number; content?: { size?: number } };
    plugins?: ReadonlyArray<Plugin>;
  };
  dom?: Element;
}

interface ProsemirrorBindingShape {
  prosemirrorView?: PmViewShape;
  type?: { toArray?: () => unknown[]; length?: number };
}

interface EditorContentShape {
  props?: { editor?: unknown };
  // biome-ignore lint/suspicious/noExplicitAny: react component internal
  [k: string]: any;
}

function docSizeOf(
  x: { doc?: { nodeSize?: number; content?: { size?: number } } } | undefined,
): number | null {
  if (!x?.doc) return null;
  if (typeof x.doc.nodeSize === 'number') return x.doc.nodeSize;
  if (x.doc.content && typeof x.doc.content.size === 'number') return x.doc.content.size;
  return null;
}

let forceRerenderCount = 0;
let pmUpdateStateCount = 0;
let pmSetPropsCount = 0;
let createNodeViewsCount = 0;

/**
 * Track the most recent `Editor.mount` finish time so the paint observer can
 * emit a bracketing `ok/cold/append-to-paint` span on the next paint event.
 * Cleared once consumed; null means "no pending mount → don't emit".
 */
let pendingAppendStartMs: number | null = null;

/** PluginKey-string prefixes the decoration patch tracks. */
const TARGET_DECORATION_KEY_PREFIXES = ['linkResolutionDecoration$'] as const;

/** Editors whose per-mount instrumentation patches have already been applied. */
const patchedEditors = new WeakSet<object>();
/** Plugins whose `props.decorations` we've already wrapped (avoid double-wrap on re-createView). */
const patchedPlugins = new WeakSet<Plugin>();

/**
 * camelCase / PascalCase → kebab-case. `ok/<subsystem>/<event>` mark names
 * require `[a-z0-9-]` in the event segment, so extension and hook identifiers
 * are normalized before being interpolated.
 */
function lowerDash(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Install gate — exported so `main.tsx` and the per-component patches inside
 * this module read the same decision. Three input channels, checked in order:
 *
 * 1. `VITE_OK_PERF_INSTRUMENT === '1'` — PROD-build override. When set, the
 *    instrumentation installs unconditionally (including in PROD builds) so
 *    ship-gate measurement can re-baseline against the true user-visible
 *    attack surface rather than the StrictMode-off dev proxy. The literal
 *    string `'1'` (not boolean true) matches Vite's env-var serialization.
 *    Lives under the default `VITE_` envPrefix (alongside the rest of the
 *    `VITE_OK_PERF_*` rollout flags) so no custom prefix is needed; the
 *    namespace stays free of secrets by mechanical convention rather than
 *    a startsWith() rule.
 *
 * 2. `PROD === true` — short-circuit for normal production builds. Without
 *    this gate, the prototype monkey-patches would carry per-call overhead
 *    into shipped builds.
 *
 * 3. Default — install in DEV / `bun test` / Playwright contexts (where PROD
 *    is false or undefined). `import.meta.env?.` optional chains so calls
 *    from non-Vite contexts (where the global may be absent) don't throw.
 */
export function shouldInstallColdMountInstrumentation(): boolean {
  if (import.meta.env?.VITE_OK_PERF_INSTRUMENT === '1') return true;
  return import.meta.env?.PROD !== true;
}

/**
 * Defense-in-depth gate. The install site is already gated by
 * `shouldInstallColdMountInstrumentation`, but a runtime check inside hot
 * paths means accidental invocation in PROD (manual call, third-party caller)
 * still no-ops with zero overhead. Single source of truth for the install
 * decision keeps the per-component patches and the install site in sync —
 * if one fires, both fire.
 */
function instrumentationDisabled(): boolean {
  return !shouldInstallColdMountInstrumentation();
}

/**
 * Wrap a single NodeView factory so each invocation emits a span tagged with
 * the node type. Per-call (not aggregated) — the cold-mount correlator sums
 * by name across the cold-mount window. Forwards all 5 PM args + return value.
 */
function wrapNodeViewFactory(nodeName: string, factory: NodeViewConstructor): NodeViewConstructor {
  if (instrumentationDisabled()) return factory;
  const dashName = lowerDash(nodeName);
  const markName = `ok/cold/nodeview-factory-${dashName}`;
  return function wrappedFactory(...args: Parameters<NodeViewConstructor>) {
    const start = performance.now();
    try {
      return factory(...args);
    } finally {
      const dur = performance.now() - start;
      mark(
        markName,
        { nodeType: nodeName, durationMs: Math.round(dur * 1000) / 1000 },
        { startTime: start, duration: dur },
      );
    }
  } as NodeViewConstructor;
}

/**
 * Walk an editor's `view.state.plugins` and replace the bound `props.decorations`
 * of any plugin whose key matches `TARGET_DECORATION_KEY_PREFIXES` with a timing
 * wrapper. Idempotent via `patchedPlugins` WeakSet — safe to call repeatedly.
 *
 * PM's `someProp('decorations')` walks each plugin's `plugin.props.decorations`
 * (the bound version, set in PM's Plugin constructor: `this.props[prop] =
 * spec.props[prop].bind(this)`). Replacing that field captures all subsequent
 * calls without touching `plugin.spec`.
 */
function patchEditorDecorationPlugins(view: EditorView): void {
  if (instrumentationDisabled()) return;
  const plugins = view.state.plugins;
  for (const plugin of plugins) {
    if (patchedPlugins.has(plugin)) continue;
    const keyStr = (plugin.spec as { key?: { key?: string } })?.key?.key;
    if (!keyStr) continue;
    if (!TARGET_DECORATION_KEY_PREFIXES.some((p) => keyStr.startsWith(p))) continue;
    const propsBag = plugin.props as { decorations?: (...args: unknown[]) => unknown };
    const original = propsBag.decorations;
    if (typeof original !== 'function') {
      patchedPlugins.add(plugin);
      continue;
    }
    const dashKey = lowerDash(keyStr.replace(/\$\d*$/, '')); // strip the $N counter
    const markName = `ok/cold/decoration-${dashKey}`;
    propsBag.decorations = function timedDecorations(this: Plugin, ...args: unknown[]) {
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        const dur = performance.now() - start;
        mark(
          markName,
          { pluginKey: keyStr, durationMs: Math.round(dur * 1000) / 1000 },
          { startTime: start, duration: dur },
        );
      }
    } as typeof original;
    patchedPlugins.add(plugin);
  }
}

/**
 * Walk an editor's `view.props.nodeViews` and wrap each factory in place so
 * subsequent PM `buildNodeViews` calls emit per-factory spans. Idempotent at
 * editor scope via `patchedEditors`.
 *
 * NodeViews live on `editor.view.someProp('nodeViews')` (a merged view of
 * `_props` + extension contributions) but PM's actual call site is
 * `editor.view._props.nodeViews` (the directProps slot — which `setProps`
 * mutates in place via `Object.assign`). We mutate that slot's entries.
 */
function patchEditorNodeViews(view: EditorView): void {
  if (instrumentationDisabled()) return;
  // PM stores directProps under `_props` (private). Access defensively.
  const internal = view as unknown as { _props?: { nodeViews?: Record<string, unknown> } };
  const nodeViews = internal._props?.nodeViews;
  if (!nodeViews || typeof nodeViews !== 'object') return;
  for (const [name, factory] of Object.entries(nodeViews)) {
    if (typeof factory !== 'function') continue;
    // Re-wrapping is harmless but wasteful; the WeakSet check happens at
    // editor scope (caller-side). Tag wrapped factories so we don't double-wrap
    // even if the same factory object is shared across editors.
    const tagged = factory as { __okWrapped?: true };
    if (tagged.__okWrapped === true) continue;
    const wrapped = wrapNodeViewFactory(name, factory as NodeViewConstructor);
    (wrapped as unknown as { __okWrapped: true }).__okWrapped = true;
    nodeViews[name] = wrapped;
  }
}

/**
 * Wrap each extension's lifecycle hooks (`onBeforeCreate`, `onCreate`,
 * `onUpdate`, `onDestroy`) with per-hook timing. Returns a NEW extension array
 * (via `.extend()`) so callers must use the returned list — the originals are
 * unchanged.
 *
 * Each child extension delegates to `this.parent?.()` so any user-supplied
 * hook on the parent still fires. `parent` is `null` when the parent has no
 * hook; in that case the wrapped span captures only the empty wrapper cost
 * (sub-microsecond). PROD short-circuits to identity.
 *
 * Wire site: `packages/app/src/editor/TiptapEditor.tsx` — pass the full
 * extension list (sharedExtensions + Placeholder + Collaboration + the
 * imageUploadDecoration / collaborationCursor anonymous extensions) through
 * this factory before handing it to `new Editor({ extensions: ... })`.
 */
export function wrapExtensionsWithTiming<E extends AnyExtension>(extensions: E[]): E[] {
  if (instrumentationDisabled()) return extensions;
  return extensions.map((ext) => {
    const name = ext.name ?? 'unknown';
    const dashName = lowerDash(name);
    return ext.extend({
      onBeforeCreate(this: { parent?: (() => void) | null }) {
        const start = performance.now();
        try {
          this.parent?.();
        } finally {
          const dur = performance.now() - start;
          mark(
            `ok/cold/ext-${dashName}-on-before-create`,
            { ext: name, hook: 'onBeforeCreate', durationMs: Math.round(dur * 1000) / 1000 },
            { startTime: start, duration: dur },
          );
        }
      },
      onCreate(this: { parent?: (() => void) | null }) {
        const start = performance.now();
        try {
          this.parent?.();
        } finally {
          const dur = performance.now() - start;
          mark(
            `ok/cold/ext-${dashName}-on-create`,
            { ext: name, hook: 'onCreate', durationMs: Math.round(dur * 1000) / 1000 },
            { startTime: start, duration: dur },
          );
        }
      },
      onUpdate(this: { parent?: (() => void) | null }) {
        const start = performance.now();
        try {
          this.parent?.();
        } finally {
          const dur = performance.now() - start;
          mark(
            `ok/cold/ext-${dashName}-on-update`,
            { ext: name, hook: 'onUpdate', durationMs: Math.round(dur * 1000) / 1000 },
            { startTime: start, duration: dur },
          );
        }
      },
      onDestroy(this: { parent?: (() => void) | null }) {
        const start = performance.now();
        try {
          this.parent?.();
        } finally {
          const dur = performance.now() - start;
          mark(
            `ok/cold/ext-${dashName}-on-destroy`,
            { ext: name, hook: 'onDestroy', durationMs: Math.round(dur * 1000) / 1000 },
            { startTime: start, duration: dur },
          );
        }
      },
    }) as E;
  });
}

export function installColdMountInstrumentation(): void {
  if (installed) return;
  installed = true;

  // -------- Editor (TipTap) ----------
  wrapMethod(
    Editor.prototype as unknown as Record<string, unknown>,
    'mount',
    'ok/cold/editor-mount',
    (self, _r, _s, durationMs) => {
      const ei = self as unknown as EditorInstanceShape;
      // Capture mount-end time so the next paint can bracket the
      // appendChild → first-paint window.
      if (!instrumentationDisabled()) {
        pendingAppendStartMs = performance.now();
      }
      return {
        elementDefault: (ei.options?.element as Element | undefined)?.nodeName ?? null,
        docSize: docSizeOf(
          ei.editorState as { doc?: { nodeSize?: number; content?: { size?: number } } },
        ),
        durationMs,
      };
    },
  );

  // @tiptap/core marks createView as private in TS but it's a runtime prototype method
  wrapMethod(
    Editor.prototype as unknown as Record<string, unknown>,
    'createView' as 'mount',
    'ok/cold/editor-create-view',
    (self) => {
      const ei = self as unknown as EditorInstanceShape;
      // After view+state are set, walk plugins to install per-decoration
      // timing. Per-editor idempotent via WeakSet on the editor instance.
      if (!instrumentationDisabled() && !patchedEditors.has(self) && ei.view) {
        patchEditorDecorationPlugins(ei.view as EditorView);
        patchEditorNodeViews(ei.view as EditorView);
        patchedEditors.add(self);
      }
      return {
        docSize: docSizeOf(
          ei.editorState as { doc?: { nodeSize?: number; content?: { size?: number } } },
        ),
      };
    },
  );

  wrapMethod(
    Editor.prototype as unknown as Record<string, unknown>,
    'createNodeViews',
    'ok/cold/create-node-views',
    (self, _r, _s, duration) => {
      createNodeViewsCount += 1;
      const ei = self as unknown as { view?: PmViewShape };
      // TipTap's createNodeViews calls `view.setProps({nodeViews})` —
      // re-walk in case the nodeViews object was rebuilt for this call.
      if (!instrumentationDisabled() && ei.view) {
        patchEditorNodeViews(ei.view as EditorView);
      }
      return {
        docSize: docSizeOf(ei.view as { doc?: { nodeSize?: number; content?: { size?: number } } }),
        seq: createNodeViewsCount,
        durationMs: duration,
      };
    },
  );

  // -------- EditorView (ProseMirror) ----------
  wrapMethod(
    EditorView.prototype as unknown as Record<string, unknown>,
    'updateState',
    'ok/cold/pm-update-state',
    (self, _r, _s, duration) => {
      pmUpdateStateCount += 1;
      return {
        seq: pmUpdateStateCount,
        docSize: docSizeOf((self as unknown as PmViewShape).state),
        durationMs: duration,
      };
    },
  );

  wrapMethod(
    EditorView.prototype as unknown as Record<string, unknown>,
    'setProps',
    'ok/cold/pm-set-props',
    (self, _r, _s, duration) => {
      pmSetPropsCount += 1;
      return {
        seq: pmSetPropsCount,
        docSize: docSizeOf((self as unknown as PmViewShape).state),
        durationMs: duration,
      };
    },
  );

  // -------- ProsemirrorBinding (y-prosemirror via @tiptap/y-tiptap) ----------
  wrapMethod(
    ProsemirrorBinding.prototype as unknown as Record<string, unknown>,
    '_forceRerender',
    'ok/cold/force-rerender',
    (self, _r, _s, duration) => {
      forceRerenderCount += 1;
      const b = self as unknown as ProsemirrorBindingShape;
      const topLevelCount = (() => {
        try {
          return b.type?.toArray ? b.type.toArray().length : null;
        } catch {
          return null;
        }
      })();
      return {
        seq: forceRerenderCount,
        topLevelYElements: topLevelCount,
        durationMs: duration,
      };
    },
  );

  // -------- PureEditorContent.init (TipTap React) ----------
  wrapMethod(
    PureEditorContent.prototype as unknown as Record<string, unknown>,
    'init',
    'ok/cold/ec-init',
    (self) => {
      const ec = self as unknown as EditorContentShape;
      return { editorPresent: Boolean(ec.props?.editor) };
    },
  );

  // -------- Paint observer ----------
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const name = entry.name;
          // first-paint or first-contentful-paint
          if (name === 'first-paint' || name === 'first-contentful-paint') {
            mark(
              name === 'first-paint' ? 'ok/cold/paint-fp' : 'ok/cold/paint-fcp',
              { entryType: entry.entryType, startTime: Math.round(entry.startTime * 1000) / 1000 },
              { startTime: entry.startTime, duration: 0 },
            );
            // Bracket span from last mount-end to this paint event.
            // Only emit on first-paint (first-contentful-paint is informational
            // and would emit a duplicate bracket); only if a pending mount is
            // queued so multi-mount scenarios don't bleed into one another.
            if (
              !instrumentationDisabled() &&
              name === 'first-paint' &&
              pendingAppendStartMs !== null
            ) {
              const start = pendingAppendStartMs;
              const dur = Math.max(0, entry.startTime - start);
              mark(
                'ok/cold/append-to-paint',
                {
                  paintEntryType: entry.entryType,
                  durationMs: Math.round(dur * 1000) / 1000,
                  paintAt: Math.round(entry.startTime * 1000) / 1000,
                },
                { startTime: start, duration: dur },
              );
              pendingAppendStartMs = null;
            }
          }
        }
      });
      obs.observe({ type: 'paint', buffered: true });
    }
  } catch {
    // Paint observer unsupported — not fatal.
  }

  // Diagnostic flag — Playwright scenario can assert via window
  (globalThis as unknown as Record<string, unknown>).__okColdMountInstrumented = true;
}
