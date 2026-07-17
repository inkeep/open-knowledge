import { afterEach, describe, expect, mock, setSystemTime, test, vi } from 'bun:test';
import type { Mock } from './bun-test-shim';
import * as shim from './bun-test-shim';
import { installCrossDirTargetMock } from './fixtures/cross-dir/mock-installer';

// If the alias or the shim regressed, this file would not even import: the
// `from 'bun:test'` specifiers above resolve only through the configured alias.

describe('bun:test shim', () => {
  test('re-exports the full runtime surface the suite imports from bun:test', () => {
    const surface: Record<string, unknown> = {
      describe: shim.describe,
      test: shim.test,
      it: shim.it,
      expect: shim.expect,
      beforeEach: shim.beforeEach,
      afterEach: shim.afterEach,
      beforeAll: shim.beforeAll,
      afterAll: shim.afterAll,
      spyOn: shim.spyOn,
      mock: shim.mock,
      jest: shim.jest,
      vi: shim.vi,
      setDefaultTimeout: shim.setDefaultTimeout,
    };
    for (const [name, value] of Object.entries(surface)) {
      expect(value, `missing shim export: ${name}`).toBeDefined();
    }
    expect(typeof shim.mock.module).toBe('function');
    // `Mock` is a type-only export; annotating with it proves it resolves.
    const typed: Mock | undefined = undefined;
    expect(typed).toBeUndefined();
  });

  test('setDefaultTimeout is callable and re-configures the runtime', () => {
    expect(() => {
      shim.setDefaultTimeout(20_000);
    }).not.toThrow();
  });

  test('mock.module facade mocks a subsequently dynamic-imported module', async () => {
    mock.module('./fixtures/mockable', () => ({ greet: () => 'mocked' }));
    const mocked = await import('./fixtures/mockable');
    expect(mocked.greet()).toBe('mocked');
    mock.restore();
  });

  test('mock.module facade mocks a subsequently dynamic-imported BARE package', async () => {
    // A bare package specifier resolves relative to the test module, not this
    // shim. Under pnpm's isolated node_modules the two can be different physical
    // copies, so keying the mock against the shim (plain `vi.doMock`) would miss
    // the dynamic import below. `smol-toml` is a real dependency: a passing
    // assertion proves the mock overrides the genuine export.
    const SENTINEL = { __bare_specifier_mock__: true };
    mock.module('smol-toml', () => ({ parse: () => SENTINEL }));
    const mocked = (await import('smol-toml')) as unknown as { parse: (s: string) => unknown };
    expect(mocked.parse('a = 1')).toBe(SENTINEL);
    mock.restore();
  });

  test('mock.module registers a bare-package mock against the test module, not the shim', () => {
    // Regression guard for the pnpm resolution fix: the mock must be keyed
    // against the calling test module so the specifier resolves through the same
    // Vite base the SUT imports through. A revert to plain `vi.doMock` would key
    // it against this shim file instead. Because the self-test shares a directory
    // with the shim, a behavioral assertion cannot distinguish the two — so pin
    // the importer directly.
    const mocker = (globalThis as { __vitest_mocker__?: { queueMock: unknown } }).__vitest_mocker__;
    expect(mocker, 'vitest mocker global must be present').toBeDefined();
    const queueMock = vi.spyOn(mocker as { queueMock: (...args: unknown[]) => void }, 'queueMock');
    try {
      mock.module('smol-toml', () => ({ parse: () => null }));
      const call = queueMock.mock.calls.find(([rawId]) => rawId === 'smol-toml');
      expect(call, 'queueMock must be invoked for the bare specifier').toBeDefined();
      const importer = call?.[1] as string;
      expect(importer.endsWith('bun-test-shim.test.ts')).toBe(true);
      expect(importer.endsWith('bun-test-shim.ts')).toBe(false);
    } finally {
      queueMock.mockRestore();
      mock.restore();
    }
  });

  test('mock.module resolves a relative specifier against the CALLER, cross-directory', async () => {
    // The installer lives in fixtures/cross-dir/ and mocks './target' relative
    // to ITS OWN directory. This test lives in test-support/, a different dir.
    // If callerFile()/absolutize() work, the mock keys against
    // fixtures/cross-dir/target.ts (which the import below resolves to). If they
    // instead resolved against this test's directory (or left the specifier
    // relative), the key would miss and the dynamic import would get the real
    // module, so the 'mocked-cross-dir' assertion genuinely discriminates.
    installCrossDirTargetMock();
    const mocked = await import('./fixtures/cross-dir/target');
    expect(mocked.greet()).toBe('mocked-cross-dir');
    mock.restore();
  });
});

describe('test.if / it.if conditional registration', () => {
  // These cases register at collection time; the bodies below run in source
  // order before the final assertion test, which reads the flags they set.
  let ranWhenTrue = false;
  let ranWhenFalse = false;
  let ranWhenTruthyValue = false;
  let ranWhenZero = false;
  let ranWhenEmptyString = false;

  test.if(true)('runs the body when the condition is true', () => {
    ranWhenTrue = true;
  });
  test.if(false)('is skipped when the condition is false', () => {
    ranWhenFalse = true;
  });
  test.if('nonempty')('runs when the condition is a truthy non-boolean', () => {
    ranWhenTruthyValue = true;
  });
  test.if(0)('is skipped when the condition is a falsy number (0)', () => {
    ranWhenZero = true;
  });
  test.if('')('is skipped when the condition is a falsy empty string', () => {
    ranWhenEmptyString = true;
  });

  test('.if is installed as a function on the shared test/it callables', () => {
    expect(typeof (test as unknown as { if?: unknown }).if).toBe('function');
    expect(typeof (shim.it as unknown as { if?: unknown }).if).toBe('function');
  });

  test('ran exactly the truthy-condition bodies and skipped the falsy ones', () => {
    expect(ranWhenTrue).toBe(true);
    expect(ranWhenTruthyValue).toBe(true);
    expect(ranWhenFalse).toBe(false);
    expect(ranWhenZero).toBe(false);
    expect(ranWhenEmptyString).toBe(false);
  });
});

describe('setSystemTime', () => {
  afterEach(() => {
    // Guarantee the faked Date never leaks into a later test even if an
    // assertion above throws before the no-arg restore runs.
    vi.useRealTimers();
  });

  test('freezes Date to the set instant', () => {
    setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    expect(new Date().toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(Date.now()).toBe(Date.parse('2020-01-01T00:00:00.000Z'));
  });

  test('leaves real timers running while Date stays frozen', async () => {
    setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    const frozenBefore = Date.now();
    // Only Date is faked (toFake: ['Date']); a real setTimeout must still fire.
    // If timers were faked too this promise would never resolve and the test
    // would time out — so its resolution proves timers stayed real.
    const fired = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 5);
    });
    expect(fired).toBe(true);
    // Real wall time advanced during the await, but the faked Date did not.
    expect(Date.now()).toBe(frozenBefore);
  });

  test('a no-arg call restores the real wall clock', () => {
    setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    expect(new Date().getUTCFullYear()).toBe(2020);
    setSystemTime();
    // Back on the real clock, which is well past 2020.
    expect(new Date().getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });
});

describe('vitest-internal mocker canary', () => {
  // Version-pinned tripwire: the bare-specifier path of mock.module keys mocks
  // through the private `globalThis.__vitest_mocker__.queueMock(rawId, importer,
  // factory)`. If a Vitest bump renames/removes/reshapes that internal, mocking
  // would silently break across the whole flipped suite — so fail LOUDLY here
  // instead. Verified against vitest 4.1.10; re-confirm the shape on a bump.
  test('__vitest_mocker__.queueMock has the (rawId, importer, factory) shape the shim depends on', () => {
    const mocker = (globalThis as { __vitest_mocker__?: { queueMock?: unknown } })
      .__vitest_mocker__;
    expect(mocker, 'globalThis.__vitest_mocker__ must be installed by Vitest').toBeDefined();
    const queueMock = mocker?.queueMock;
    expect(typeof queueMock, 'mocker.queueMock must be a function').toBe('function');
    expect(
      (queueMock as (...a: unknown[]) => unknown).length,
      'queueMock must take (rawId, importer, factory) — an arity change means the importer contract moved',
    ).toBe(3);
  });
});
