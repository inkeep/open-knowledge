
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
    const [wrapped] = wrapExtensionsWithTiming([ext]);
    const onCreate = (wrapped as unknown as { config: { onCreate?: (this: ParentScope) => void } })
      .config.onCreate;
    expect(() => onCreate?.call({ parent: null })).not.toThrow();
    const names = getMarkNames();
    expect(names).toContain('ok/cold/ext-no-hook-on-create');
  });
});

describe('shouldInstallColdMountInstrumentation (D18 PROD-build override)', () => {
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
    expect(shouldInstallColdMountInstrumentation()).toBe(true);
  });

  test('per-component patches honor the gate end-to-end (PROD without override → identity)', () => {
    (import.meta.env as Record<string, unknown>).PROD = true;
    const ext = Extension.create({ name: 'gateProbe' });
    const out = wrapExtensionsWithTiming([ext]);
    expect(out[0]).toBe(ext);
  });

  test('per-component patches honor the gate end-to-end (PROD with override → wraps)', () => {
    (import.meta.env as Record<string, unknown>).PROD = true;
    (import.meta.env as Record<string, unknown>).VITE_OK_PERF_INSTRUMENT = '1';
    const ext = Extension.create({ name: 'gateProbe' });
    const out = wrapExtensionsWithTiming([ext]);
    expect(out[0]).not.toBe(ext);
    expect(out[0].name).toBe('gateProbe');
  });
});

describe('wrapMethod — error propagation contract', () => {

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
      return { wasCalled: true };
    });
    try {
      (target.method as () => void)();
    } catch {
    }
    expect(propsBuilderInvocations).toBe(0);
  });

  test('propsBuilder throw on success path is swallowed; original return value propagates', () => {
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
