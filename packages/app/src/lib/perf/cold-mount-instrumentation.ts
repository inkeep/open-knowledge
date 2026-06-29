import { type AnyExtension, Editor } from '@tiptap/core';
import type { Plugin } from '@tiptap/pm/state';
import { EditorView, type NodeViewConstructor } from '@tiptap/pm/view';
import { PureEditorContent } from '@tiptap/react';
import { ProsemirrorBinding } from '@tiptap/y-tiptap';
import { mark } from './mark';

let installed = false;

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
      } catch {}
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

let pendingAppendStartMs: number | null = null;

const TARGET_DECORATION_KEY_PREFIXES = ['linkResolutionDecoration$'] as const;

const patchedEditors = new WeakSet<object>();
const patchedPlugins = new WeakSet<Plugin>();

function lowerDash(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export function shouldInstallColdMountInstrumentation(): boolean {
  if (import.meta.env?.VITE_OK_PERF_INSTRUMENT === '1') return true;
  return import.meta.env?.PROD !== true;
}

function instrumentationDisabled(): boolean {
  return !shouldInstallColdMountInstrumentation();
}

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

function patchEditorNodeViews(view: EditorView): void {
  if (instrumentationDisabled()) return;
  const internal = view as unknown as { _props?: { nodeViews?: Record<string, unknown> } };
  const nodeViews = internal._props?.nodeViews;
  if (!nodeViews || typeof nodeViews !== 'object') return;
  for (const [name, factory] of Object.entries(nodeViews)) {
    if (typeof factory !== 'function') continue;
    const tagged = factory as { __okWrapped?: true };
    if (tagged.__okWrapped === true) continue;
    const wrapped = wrapNodeViewFactory(name, factory as NodeViewConstructor);
    (wrapped as unknown as { __okWrapped: true }).__okWrapped = true;
    nodeViews[name] = wrapped;
  }
}

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

  wrapMethod(
    Editor.prototype as unknown as Record<string, unknown>,
    'mount',
    'ok/cold/editor-mount',
    (self, _r, _s, durationMs) => {
      const ei = self as unknown as EditorInstanceShape;
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

  wrapMethod(
    Editor.prototype as unknown as Record<string, unknown>,
    'createView' as 'mount',
    'ok/cold/editor-create-view',
    (self) => {
      const ei = self as unknown as EditorInstanceShape;
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

  wrapMethod(
    PureEditorContent.prototype as unknown as Record<string, unknown>,
    'init',
    'ok/cold/ec-init',
    (self) => {
      const ec = self as unknown as EditorContentShape;
      return { editorPresent: Boolean(ec.props?.editor) };
    },
  );

  try {
    if (typeof PerformanceObserver !== 'undefined') {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const name = entry.name;
          if (name === 'first-paint' || name === 'first-contentful-paint') {
            mark(
              name === 'first-paint' ? 'ok/cold/paint-fp' : 'ok/cold/paint-fcp',
              { entryType: entry.entryType, startTime: Math.round(entry.startTime * 1000) / 1000 },
              { startTime: entry.startTime, duration: 0 },
            );
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
  } catch {}

  (globalThis as unknown as Record<string, unknown>).__okColdMountInstrumented = true;
}
