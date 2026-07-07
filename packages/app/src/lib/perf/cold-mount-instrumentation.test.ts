/**
 * Unit tests for `wrapExtensionsWithTiming` — the only export of
 * cold-mount-instrumentation.ts that is unit-testable in isolation. The other
 * patches (per-NodeView factory, per-decoration plugin, append-to-paint
 * bracket) hook prototype methods on TipTap / PM / yjs and require a full
 * mounted editor; their integration coverage lives in
 * `tests/perf/scenarios/g4-profile-decomposition.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Extension } from '@tiptap/core';
import {
  shouldInstallColdMountInstrumentation,
  wrapExtensionsWithTiming,
  wrapMethod,
} from './cold-mount-instrumentation';
import { getCollector } from './collector';

interface ParentScope {
  parent?: (() => void) | null;
}

function clearMeasures(): void {
  try {
    performance.clearMeasures();
  } catch {
    // ignore in envs where clearMeasures throws
  }
}

function getMarkNames(): string[] {
  return performance.getEntriesByType('measure').map((e) => e.name);
}

describe('wrapExtensionsWithTiming', () => {
  beforeEach(() => {
    getCollector()?.reset();
    clearMeasures();
  });

  afterEach(() => {
    clearMeasures();
  });

  test('preserves extension name + identity (returns derived extension)', () => {
    const original = Extension.create({ name: 'wikiLink' });
    const [wrapped] = wrapExtensionsWithTiming([original]);
    expect(wrapped.name).toBe('wikiLink');
    // .extend() returns a child extension whose parent is the original.
    expect((wrapped as unknown as { parent?: unknown }).parent).toBe(original);
  });

  test('returns array of same length, in same order', () => {
    const a = Extension.create({ name: 'extA' });
    const b = Extension.create({ name: 'extB' });
    const c = Extension.create({ name: 'extC' });
    const out = wrapExtensionsWithTiming([a, b, c]);
    expect(out).toHaveLength(3);
    expect(out[0].name).toBe('extA');
    expect(out[1].name).toBe('extB');
    expect(out[2].name).toBe('extC');
  });

  test('emits ok/cold/ext-{name}-on-create when child onCreate fires', () => {
    const ext = Extension.create({ name: 'wikiLink' });
    const [wrapped] = wrapExtensionsWithTiming([ext]);
    const onCreate = (wrapped as unknown as { config: { onCreate?: (this: ParentScope) => void } })
      .config.onCreate;
    expect(typeof onCreate).toBe('function');
    onCreate?.call({ parent: null } as ParentScope);
    const names = getMarkNames();
    expect(names).toContain('ok/cold/ext-wiki-link-on-create');
  });

  test('emits all four lifecycle marks (onBeforeCreate, onCreate, onUpdate, onDestroy)', () => {
    const ext = Extension.create({ name: 'plain' });
    const [wrapped] = wrapExtensionsWithTiming([ext]);
    const cfg = (
      wrapped as unknown as {
        config: {
          onBeforeCreate?: (this: ParentScope) => void;
          onCreate?: (this: ParentScope) => void;
          onUpdate?: (this: ParentScope) => void;
          onDestroy?: (this: ParentScope) => void;
        };
      }
    ).config;
    cfg.onBeforeCreate?.call({ parent: null });
    cfg.onCreate?.call({ parent: null });
    cfg.onUpdate?.call({ parent: null });
    cfg.onDestroy?.call({ parent: null });
    const names = getMarkNames();
    expect(names).toContain('ok/cold/ext-plain-on-before-create');
    expect(names).toContain('ok/cold/ext-plain-on-create');
    expect(names).toContain('ok/cold/ext-plain-on-update');
    expect(names).toContain('ok/cold/ext-plain-on-destroy');
  });

  test('lowercases + dashes camelCase / PascalCase extension names', () => {
    const a = Extension.create({ name: 'wikiLinkEmbed' });
    const b = Extension.create({ name: 'JsxComponent' });
    const c = Extension.create({ name: 'simple' });
    const wrapped = wrapExtensionsWithTiming([a, b, c]);
    for (const w of wrapped) {
      const onCreate = (w as unknown as { config: { onCreate?: (this: ParentScope) => void } })
        .config.onCreate;
      onCreate?.call({ parent: null });
    }
    const names = getMarkNames();
    expect(names).toContain('ok/cold/ext-wiki-link-embed-on-create');
    expect(names).toContain('ok/cold/ext-jsx-component-on-create');
    expect(names).toContain('ok/cold/ext-simple-on-create');
  });

  test('calls this.parent?.() so user-supplied hooks still fire', () => {
    let parentCalls = 0;
    const ext = Extension.create({
      name: 'parentExt',
      onCreate() {
        parentCalls += 1;
      },
    });
    const [wrapped] = wrapExtensionsWithTiming([ext]);
    const onCreate = (wrapped as unknown as { config: { onCreate?: (this: ParentScope) => void } })
      .config.onCreate;
    onCreate?.call({
      parent: () => {
        parentCalls += 1;
      },
    });
    // The wrapped hook delegates via this.parent?.() — exercised once here.
    expect(parentCalls).toBe(1);
  });

  test('emits mark even when parent throws (try/finally invariant)', () => {
    const ext = Extension.create({ name: 'throwing' });
    const [wrapped] = wrapExtensionsWithTiming([ext]);
    const onCreate = (wrapped as unknown as { config: { onCreate?: (this: ParentScope) => void } })
      .config.onCreate;
    expect(() =>
      onCreate?.call({
        parent: () => {
          throw new Error('parent boom');
        },
      }),
    ).toThrow('parent boom');
    const names = getMarkNames();
    expect(names).toContain('ok/cold/ext-throwing-on-create');
  });

  test('mark detail carries ext name + hook + durationMs property', () => {
    const ext = Extension.create({ name: 'wikiLink' });
    const [wrapped] = wrapExtensionsWithTiming([ext]);
    const onCreate = (wrapped as unknown as { config: { onCreate?: (this: ParentScope) => void } })
      .config.onCreate;
    onCreate?.call({ parent: null });
    const entries = performance.getEntriesByName(
      'ok/cold/ext-wiki-link-on-create',
    ) as PerformanceMeasure[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries[entries.length - 1];
    const detail = last.detail as {
      devtools: { dataType: string; track: string; properties?: Array<[string, string]> };
    };
    expect(detail.devtools.dataType).toBe('track-entry');
    expect(detail.devtools.track).toBe('ok/cold');
    const propMap = Object.fromEntries(detail.devtools.properties ?? []);
    expect(propMap.ext).toBe('wikiLink');
    expect(propMap.hook).toBe('onCreate');
    expect(typeof propMap.durationMs).toBe('string');
  });

  test('handles empty extension array', () => {
    expect(wrapExtensionsWithTiming([])).toEqual([]);
  });

  test('handles extension whose parent has no hook (this.parent is null)', () => {
    const ext = Extension.create({ name: 'noHook' });
    // Original ext does NOT define onCreate. After wrap, calling wrapped's
    // onCreate must not throw — TipTap binds `this.parent` to null when
    // the parent chain has no implementation.
    const [wrapped] = wrapExtensionsWithTiming([ext]);
    const onCreate = (wrapped as unknown as { config: { onCreate?: (this: ParentScope) => void } })
      .config.onCreate;
    expect(() => onCreate?.call({ parent: null })).not.toThrow();
    const names = getMarkNames();
    expect(names).toContain('ok/cold/ext-no-hook-on-create');
  });
});

describe('shouldInstallColdMountInstrumentation (D18 PROD-build override)', () => {
  // Vite normally replaces `import.meta.env.PROD` and `import.meta.env.DEV`
  // at build time with literal booleans; under `bun test` these slots are
  // mutable (undefined by default) so each case can pin exactly the env
  // shape it intends to exercise.
  type EnvSlot = 'PROD' | 'DEV' | 'VITE_OK_PERF_INSTRUMENT';
  const ENV_SLOTS: readonly EnvSlot[] = ['PROD', 'DEV', 'VITE_OK_PERF_INSTRUMENT'];
  let originalEnv: Partial<Record<EnvSlot, unknown>>;

  beforeEach(() => {
    originalEnv = {};
    const env = import.meta.env as Record<string, unknown>;
    for (const slot of ENV_SLOTS) {
      originalEnv[slot] = env[slot];
      delete env[slot];
    }
  });

  afterEach(() => {
    const env = import.meta.env as Record<string, unknown>;
    for (const slot of ENV_SLOTS) {
      const original = originalEnv[slot];
      if (original === undefined) {
        delete env[slot];
      } else {
        env[slot] = original;
      }
    }
  });

  test('DEV without override → installs (existing DEV behavior preserved)', () => {
    (import.meta.env as Record<string, unknown>).DEV = true;
    expect(shouldInstallColdMountInstrumentation()).toBe(true);
  });

  test('PROD without override → skips (existing PROD short-circuit preserved as default)', () => {
    (import.meta.env as Record<string, unknown>).PROD = true;
    expect(shouldInstallColdMountInstrumentation()).toBe(false);
  });

  test('PROD with VITE_OK_PERF_INSTRUMENT=1 → installs (D18 override)', () => {
    (import.meta.env as Record<string, unknown>).PROD = true;
    (import.meta.env as Record<string, unknown>).VITE_OK_PERF_INSTRUMENT = '1';
    expect(shouldInstallColdMountInstrumentation()).toBe(true);
  });

  test('DEV with VITE_OK_PERF_INSTRUMENT=1 → installs (override is additive, never restrictive)', () => {
    (import.meta.env as Record<string, unknown>).DEV = true;
    (import.meta.env as Record<string, unknown>).VITE_OK_PERF_INSTRUMENT = '1';
    expect(shouldInstallColdMountInstrumentation()).toBe(true);
  });

  test('PROD with VITE_OK_PERF_INSTRUMENT empty string → skips (only literal "1" enables)', () => {
    (import.meta.env as Record<string, unknown>).PROD = true;
    (import.meta.env as Record<string, unknown>).VITE_OK_PERF_INSTRUMENT = '';
    expect(shouldInstallColdMountInstrumentation()).toBe(false);
  });

  test('PROD with VITE_OK_PERF_INSTRUMENT="true" → skips (only literal "1" enables)', () => {
    // Vite serializes env vars as strings — guard against the common
    // mistake of passing `'true'` and expecting boolean coercion.
    (import.meta.env as Record<string, unknown>).PROD = true;
    (import.meta.env as Record<string, unknown>).VITE_OK_PERF_INSTRUMENT = 'true';
    expect(shouldInstallColdMountInstrumentation()).toBe(false);
  });

  test('PROD with VITE_OK_PERF_INSTRUMENT=0 → skips', () => {
    (import.meta.env as Record<string, unknown>).PROD = true;
    (import.meta.env as Record<string, unknown>).VITE_OK_PERF_INSTRUMENT = '0';
    expect(shouldInstallColdMountInstrumentation()).toBe(false);
  });

  test('neither PROD nor DEV set (bun test default shape) → installs', () => {
    // No env hints at all — current bun test default. Without this case the
    // existing wrapExtensionsWithTiming suite (which relies on
    // instrumentationDisabled returning false) would silently regress.
    expect(shouldInstallColdMountInstrumentation()).toBe(true);
  });

  test('per-component patches honor the gate end-to-end (PROD without override → identity)', () => {
    // Verifies the full chain: gate → instrumentationDisabled →
    // per-component short-circuit. wrapExtensionsWithTiming is the externally
    // visible per-component primitive that returns identity (the same input
    // array) when instrumentation is disabled.
    (import.meta.env as Record<string, unknown>).PROD = true;
    const ext = Extension.create({ name: 'gateProbe' });
    const out = wrapExtensionsWithTiming([ext]);
    expect(out[0]).toBe(ext);
  });

  test('per-component patches honor the gate end-to-end (PROD with override → wraps)', () => {
    // Same scenario flipped: with VITE_OK_PERF_INSTRUMENT=1, the gate flips and
    // wrapExtensionsWithTiming returns a derived (wrapped) extension. Pairs
    // with the previous test to prove both branches of the decision land.
    (import.meta.env as Record<string, unknown>).PROD = true;
    (import.meta.env as Record<string, unknown>).VITE_OK_PERF_INSTRUMENT = '1';
    const ext = Extension.create({ name: 'gateProbe' });
    const out = wrapExtensionsWithTiming([ext]);
    expect(out[0]).not.toBe(ext);
    expect(out[0].name).toBe('gateProbe');
  });
});

describe('wrapMethod — error propagation contract', () => {
  // Pattern C tests:
  // exercise real failure-inducing input (an `original` that throws) through
  // the public `wrapMethod` interface and assert the user-observable contract:
  // the original error propagates verbatim; instrumentation side effects
  // never hijack control flow.
  //
  // Regression context: a prior pattern ran `propsBuilder` inside the wrapped
  // method's `finally{}` block unconditionally. When `original.apply` threw
  // (e.g., TipTap's `Editor.createView` rejecting a malformed PM schema), the
  // finally still ran propsBuilder, which read partially-constructed state
  // (e.g., `editor.view._props` while `editor.editorView` is null) and
  // triggered TipTap's throwing-proxy. The secondary throw shadowed the
  // original, so the surfaced error was always "view['_props']" instead of
  // the real schema rejection. This test class pins the fix.

  beforeEach(() => {
    getCollector()?.reset();
    clearMeasures();
  });

  afterEach(() => {
    clearMeasures();
  });

  test('original error propagates verbatim when original method throws', () => {
    class OriginalError extends Error {
      constructor() {
        super('synthetic original failure');
        this.name = 'OriginalError';
      }
    }
    const target: Record<string, unknown> = {
      method() {
        throw new OriginalError();
      },
    };
    wrapMethod(target, 'method', 'ok/cold/test-throw-prop');
    expect(() => (target.method as () => void)()).toThrow(OriginalError);
  });

  test('propsBuilder is NOT invoked on the throw path', () => {
    let propsBuilderInvocations = 0;
    const target: Record<string, unknown> = {
      method() {
        throw new Error('original failure');
      },
    };
    wrapMethod(target, 'method', 'ok/cold/test-throw-no-props', () => {
      propsBuilderInvocations += 1;
      // If this ever runs on the throw path, the original-error contract is
      // broken because state reads can throw and shadow the original.
      return { wasCalled: true };
    });
    try {
      (target.method as () => void)();
    } catch {
      /* expected */
    }
    expect(propsBuilderInvocations).toBe(0);
  });

  test('propsBuilder throw on success path is swallowed; original return value propagates', () => {
    // Defense-in-depth: even on the success path, a buggy propsBuilder must
    // not hijack the original return value or mask other errors. The throw
    // is captured into the timing mark's props as `instrumentation-error`.
    const target: Record<string, unknown> = {
      method() {
        return 'original-success-return';
      },
    };
    wrapMethod(target, 'method', 'ok/cold/test-success-props-throw', () => {
      throw new Error('synthetic propsBuilder failure');
    });
    const ret = (target.method as () => string)();
    expect(ret).toBe('original-success-return');

    const collected = getCollector()
      ?.marks.toArray()
      .find((m) => m.name === 'ok/cold/test-success-props-throw');
    expect(collected).toBeDefined();
    expect(collected?.properties?.['instrumentation-error']).toBe('synthetic propsBuilder failure');
  });

  test('timing mark is emitted on both success and throw paths with `threw` discriminator', () => {
    // Marks must always fire so cost is attributable on either path. The
    // `threw` boolean lets the collector distinguish failed mounts from
    // successful ones in trace analysis.
    const successTarget: Record<string, unknown> = { ok: () => 42 };
    const throwTarget: Record<string, unknown> = {
      bad: () => {
        throw new Error('x');
      },
    };
    wrapMethod(successTarget, 'ok', 'ok/cold/test-mark-success');
    wrapMethod(throwTarget, 'bad', 'ok/cold/test-mark-throw');

    (successTarget.ok as () => number)();
    try {
      (throwTarget.bad as () => void)();
    } catch {
      /* expected */
    }

    const successMark = getCollector()
      ?.marks.toArray()
      .find((m) => m.name === 'ok/cold/test-mark-success');
    const throwMark = getCollector()
      ?.marks.toArray()
      .find((m) => m.name === 'ok/cold/test-mark-throw');
    expect(successMark).toBeDefined();
    expect(throwMark).toBeDefined();
    expect(successMark?.properties?.threw).toBe(false);
    expect(throwMark?.properties?.threw).toBe(true);
  });
});
