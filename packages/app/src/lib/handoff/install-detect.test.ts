/**
 * Unit tests for the pure install-detection primitive powering the
 * Open-in-Agent dropdown.
 *
 * Covered surfaces:
 *   (a) `schemeStatesToTargetStates` — per-scheme → per-target mapping with
 *       web-host Cursor override.
 *   (b) `initialTargetStates` — pre-probe snapshot shape per host.
 *   (c) `probeViaElectron` — parallel IPC fan-out with per-scheme rejection
 *       tolerance.
 *   (d) `probeViaFetch` — server endpoint + conservative-false defaults on
 *       network / parse / non-200 failures; AbortError propagates.
 *   (e) `createProbeCoordinator` — throttle + inflight dedup + subscribe
 *       semantics + web-host override + change-only notification.
 *
 * The Bun test runner runs this file under `packages/app` with the same
 * `bun test src/` invocation as the existing suite. Nothing real I/O — an
 * injectable `now()` drives the clock; `probe` is a test-harness function.
 */

import { describe, expect, test } from 'bun:test';
import {
  createProbeCoordinator,
  DEFAULT_THROTTLE_MS,
  initialTargetStates,
  probeViaElectron,
  probeViaFetch,
  type SchemeStates,
  schemeStatesToTargetStates,
  UNIQUE_SCHEMES,
} from './install-detect.ts';

const FIXED_NOW = 1_000;

describe('UNIQUE_SCHEMES', () => {
  test('covers exactly claude: codex: cursor: with no duplicates', () => {
    expect(new Set(UNIQUE_SCHEMES)).toEqual(new Set(['claude:', 'codex:', 'cursor:']));
    expect(UNIQUE_SCHEMES.length).toBe(3);
  });
});

describe('schemeStatesToTargetStates', () => {
  test('empty scheme state → every target is installed:null (loading)', () => {
    const out = schemeStatesToTargetStates({}, { isElectronHost: true, now: () => FIXED_NOW });
    expect(out['claude-cowork'].installed).toBe(null);
    expect(out['claude-code'].installed).toBe(null);
    expect(out.codex.installed).toBe(null);
    expect(out.cursor.installed).toBe(null);
  });

  test('claude-cowork and claude-code both reflect the claude: probe result', () => {
    const states: SchemeStates = {
      'claude:': { installed: true, displayName: 'Claude' },
    };
    const out = schemeStatesToTargetStates(states, {
      isElectronHost: true,
      now: () => FIXED_NOW,
    });
    expect(out['claude-cowork'].installed).toBe(true);
    expect(out['claude-cowork'].displayName).toBe('Claude');
    expect(out['claude-code'].installed).toBe(true);
    expect(out['claude-code'].displayName).toBe('Claude');
  });

  test('lastChecked stamped from now() on every probed entry', () => {
    const states: SchemeStates = { 'codex:': { installed: false } };
    const out = schemeStatesToTargetStates(states, {
      isElectronHost: true,
      now: () => FIXED_NOW,
    });
    expect(out.codex.lastChecked).toBe(FIXED_NOW);
    // Unprobed entries don't get a timestamp.
    expect(out['claude-cowork'].lastChecked).toBeUndefined();
  });

  test('web-host Cursor reflects the probe result (no force-disabled override)', () => {
    // Cursor on web is now supported via the loopback `/api/spawn-cursor`
    // fetch fallback in `cursor-two-step.ts`. The previous force-disabled
    // override at this layer was removed because the renderer no longer
    // needs to short-circuit a row that would fail on click — both transports
    // share the same `SpawnCursor` shape and the server-side probe is the
    // single source of truth for "is Cursor installed."
    const states: SchemeStates = {
      'cursor:': { installed: true, displayName: 'Cursor' },
    };
    const out = schemeStatesToTargetStates(states, {
      isElectronHost: false,
      now: () => FIXED_NOW,
    });
    expect(out.cursor.installed).toBe(true);
    expect(out.cursor.displayName).toBe('Cursor');
  });

  test('electron-host Cursor reflects the probe result', () => {
    const states: SchemeStates = {
      'cursor:': { installed: true, displayName: 'Cursor' },
    };
    const out = schemeStatesToTargetStates(states, {
      isElectronHost: true,
      now: () => FIXED_NOW,
    });
    expect(out.cursor.installed).toBe(true);
    expect(out.cursor.displayName).toBe('Cursor');
  });
});

describe('initialTargetStates', () => {
  test('electron-host: every target is loading (installed:null)', () => {
    const out = initialTargetStates({ isElectronHost: true, now: () => 0 });
    expect(out['claude-cowork'].installed).toBe(null);
    expect(out['claude-code'].installed).toBe(null);
    expect(out.codex.installed).toBe(null);
    expect(out.cursor.installed).toBe(null);
  });

  test('web-host: every target is loading (Cursor no longer pre-disabled)', () => {
    // Cursor now has a web-host transport (`POST /api/spawn-cursor`), so the
    // pre-probe state matches every other target — wait for the actual probe.
    const out = initialTargetStates({ isElectronHost: false, now: () => 0 });
    expect(out['claude-cowork'].installed).toBe(null);
    expect(out['claude-code'].installed).toBe(null);
    expect(out.codex.installed).toBe(null);
    expect(out.cursor.installed).toBe(null);
  });
});

describe('probeViaElectron', () => {
  test('fans out one IPC call per unique scheme, in parallel, stripping trailing colon', async () => {
    const calls: string[] = [];
    const detector = async (schemeName: string) => {
      calls.push(schemeName);
      return { installed: true, displayName: `App-${schemeName}` };
    };
    const out = await probeViaElectron({ detectProtocol: detector });
    // The IPC contract is scheme NAME (no colon) — the handler's shell-injection
    // sanitizer at packages/desktop/src/main/ipc-handlers.ts rejects `:`. This
    // assertion is the regression guard for the case where the hook used
    // to pass the colonful form and every row rendered "Not installed".
    expect(new Set(calls)).toEqual(new Set(['claude', 'codex', 'cursor']));
    expect(calls.length).toBe(3);
    // But the output map is still keyed by the colonful scheme to align with
    // `KNOWN_TARGETS.schemes` + the `URL.protocol` / `ALLOWED_SCHEMES` convention.
    expect(out['claude:']?.installed).toBe(true);
    expect(out['codex:']?.installed).toBe(true);
    expect(out['cursor:']?.installed).toBe(true);
  });

  test('IPC contract: detector receives no-colon scheme name (shell-injection sanitizer matches)', async () => {
    // Tight regression test: if the hook ever regresses to passing `'claude:'`,
    // the main-process handler's `^[a-z][a-z0-9+.-]*$` sanitizer would return
    // `{installed:false}` short-circuit and the dropdown would render every
    // row disabled in production. Lock in the stripped form.
    const detector = async (schemeName: string) => {
      expect(schemeName).not.toContain(':');
      expect(/^[a-z][a-z0-9+.-]*$/i.test(schemeName)).toBe(true);
      return { installed: true };
    };
    await probeViaElectron({ detectProtocol: detector });
  });

  test('per-scheme rejection is caught and treated as installed:false', async () => {
    const detector = async (schemeName: string) => {
      if (schemeName === 'codex') throw new Error('ipc-boom');
      return { installed: true };
    };
    const out = await probeViaElectron({ detectProtocol: detector });
    expect(out['claude:']?.installed).toBe(true);
    expect(out['codex:']?.installed).toBe(false);
    expect(out['cursor:']?.installed).toBe(true);
  });

  test('displayName passthrough from detector result', async () => {
    const detector = async (schemeName: string) => ({
      installed: true,
      displayName: schemeName === 'claude' ? 'Claude' : 'OtherApp',
    });
    const out = await probeViaElectron({ detectProtocol: detector });
    expect(out['claude:']?.displayName).toBe('Claude');
    expect(out['codex:']?.displayName).toBe('OtherApp');
  });
});

describe('probeViaFetch', () => {
  function makeFetchReturning(body: unknown, status = 200): typeof globalThis.fetch {
    return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  test('issues exactly one GET /api/installed-agents with Accept json', async () => {
    const seenInputs: Array<RequestInfo | URL> = [];
    const seenInits: Array<RequestInit | undefined> = [];
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenInputs.push(input);
      seenInits.push(init);
      return new Response(JSON.stringify({ claude: true, codex: false, cursor: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    const out = await probeViaFetch({ fetch: fetchMock });
    expect(seenInputs.length).toBe(1);
    expect(seenInputs[0]).toBe('/api/installed-agents');
    const headers = (seenInits[0]?.headers as Record<string, string> | undefined) ?? {};
    expect(headers.Accept).toBe('application/json');
    expect(out['claude:']?.installed).toBe(true);
    expect(out['codex:']?.installed).toBe(false);
    expect(out['cursor:']?.installed).toBe(true);
  });

  test('non-200 response → all schemes installed:false', async () => {
    const out = await probeViaFetch({ fetch: makeFetchReturning('oops', 500) });
    expect(out['claude:']?.installed).toBe(false);
    expect(out['codex:']?.installed).toBe(false);
    expect(out['cursor:']?.installed).toBe(false);
  });

  test('network error → all schemes installed:false', async () => {
    const fetchMock = (async () => {
      throw new Error('econnrefused');
    }) as typeof globalThis.fetch;
    const out = await probeViaFetch({ fetch: fetchMock });
    expect(out['claude:']?.installed).toBe(false);
    expect(out['codex:']?.installed).toBe(false);
    expect(out['cursor:']?.installed).toBe(false);
  });

  test('malformed JSON body → all schemes installed:false', async () => {
    const out = await probeViaFetch({ fetch: makeFetchReturning('not-json{{', 200) });
    expect(out['claude:']?.installed).toBe(false);
  });

  test('array body (invalid shape) → all schemes installed:false', async () => {
    const out = await probeViaFetch({ fetch: makeFetchReturning([], 200) });
    expect(out['claude:']?.installed).toBe(false);
  });

  test('missing keys default to installed:false', async () => {
    const out = await probeViaFetch({
      fetch: makeFetchReturning({ claude: true }, 200),
    });
    expect(out['claude:']?.installed).toBe(true);
    expect(out['codex:']?.installed).toBe(false);
    expect(out['cursor:']?.installed).toBe(false);
  });

  test('AbortError propagates to caller', async () => {
    const fetchMock = (async () => {
      const err = new Error('aborted') as Error & { name: string };
      err.name = 'AbortError';
      throw err;
    }) as typeof globalThis.fetch;
    await expect(probeViaFetch({ fetch: fetchMock })).rejects.toThrow('aborted');
  });
});

describe('createProbeCoordinator — throttle, dedup, subscribe, cancel', () => {
  const HEALTHY_ALL_INSTALLED: SchemeStates = {
    'claude:': { installed: true },
    'codex:': { installed: true },
    'cursor:': { installed: true },
  };

  test('boot probe fires on first probe() call and updates subscribers', async () => {
    let callCount = 0;
    const received: Array<Record<string, unknown>> = [];
    const handle = createProbeCoordinator({
      probe: async () => {
        callCount += 1;
        return HEALTHY_ALL_INSTALLED;
      },
      isElectronHost: () => true,
      now: () => 0,
    });
    const unsub = handle.subscribe((s) => received.push(s));
    await handle.probe();
    expect(callCount).toBe(1);
    expect(received.length).toBe(1);
    const last = received[received.length - 1];
    expect(last?.['claude-cowork']).toMatchObject({ installed: true });
    unsub();
    handle.cancel();
  });

  test('3 refresh() calls within 5s produce only 1 probe (SQ5 DIRECTED)', async () => {
    let callCount = 0;
    let clock = 0;
    const handle = createProbeCoordinator({
      probe: async () => {
        callCount += 1;
        return HEALTHY_ALL_INSTALLED;
      },
      isElectronHost: () => true,
      now: () => clock,
      throttleMs: 10_000,
    });
    await handle.probe();
    clock = 2_000;
    await handle.probe();
    clock = 5_000;
    await handle.probe();
    expect(callCount).toBe(1);
    handle.cancel();
  });

  test('probe fires again after throttle window elapses', async () => {
    let callCount = 0;
    let clock = 0;
    const handle = createProbeCoordinator({
      probe: async () => {
        callCount += 1;
        return HEALTHY_ALL_INSTALLED;
      },
      isElectronHost: () => true,
      now: () => clock,
      throttleMs: 10_000,
    });
    await handle.probe();
    expect(callCount).toBe(1);
    clock = 11_000;
    await handle.probe();
    expect(callCount).toBe(2);
    handle.cancel();
  });

  test('DEFAULT_THROTTLE_MS is 10s (matches SPEC §6.4)', () => {
    expect(DEFAULT_THROTTLE_MS).toBe(10_000);
  });

  test('concurrent probe() calls share one probe execution (inflight dedup)', async () => {
    let callCount = 0;
    let resolveProbe: ((v: SchemeStates) => void) | null = null;
    const handle = createProbeCoordinator({
      probe: () => {
        callCount += 1;
        return new Promise<SchemeStates>((resolve) => {
          resolveProbe = resolve;
        });
      },
      isElectronHost: () => true,
      now: () => 0,
    });
    const pending = [
      handle.probe(),
      handle.probe(),
      handle.probe(),
      handle.probe(),
      handle.probe(),
    ];
    // All five callers picked up the same inflight promise; underlying probe
    // ran exactly once.
    expect(callCount).toBe(1);
    expect(resolveProbe).not.toBeNull();
    resolveProbe?.(HEALTHY_ALL_INSTALLED);
    await Promise.all(pending);
    expect(callCount).toBe(1);
    handle.cancel();
  });

  test('subscribe skips notify when probe returns identical state', async () => {
    const received: Array<Record<string, unknown>> = [];
    let clock = 0;
    const handle = createProbeCoordinator({
      probe: async () => HEALTHY_ALL_INSTALLED,
      isElectronHost: () => true,
      now: () => clock,
      throttleMs: 1,
    });
    handle.subscribe((s) => received.push(s));
    await handle.probe();
    const afterFirst = received.length;
    expect(afterFirst).toBe(1);
    clock = 100;
    await handle.probe();
    // Identical state → no additional notify.
    expect(received.length).toBe(afterFirst);
    handle.cancel();
  });

  test('subscribe fires when state actually changes (install-state flip)', async () => {
    const received: Array<Record<string, unknown>> = [];
    let clock = 0;
    let currentResult: SchemeStates = {
      'claude:': { installed: false },
      'codex:': { installed: false },
      'cursor:': { installed: false },
    };
    const handle = createProbeCoordinator({
      probe: async () => currentResult,
      isElectronHost: () => true,
      now: () => clock,
      throttleMs: 1,
    });
    handle.subscribe((s) => received.push(s));
    await handle.probe();
    const afterFirst = received.length;
    expect(afterFirst).toBe(1);
    clock = 100;
    currentResult = HEALTHY_ALL_INSTALLED;
    await handle.probe();
    expect(received.length).toBe(afterFirst + 1);
    const last = received[received.length - 1];
    expect(last?.codex).toMatchObject({ installed: true });
    handle.cancel();
  });

  test('cancel() stops further notifications even for inflight probes', async () => {
    const received: Array<Record<string, unknown>> = [];
    let resolveProbe: ((v: SchemeStates) => void) | null = null;
    const handle = createProbeCoordinator({
      probe: () =>
        new Promise<SchemeStates>((r) => {
          resolveProbe = r;
        }),
      isElectronHost: () => true,
      now: () => 0,
    });
    handle.subscribe((s) => received.push(s));
    const pending = handle.probe();
    handle.cancel();
    resolveProbe?.(HEALTHY_ALL_INSTALLED);
    await pending;
    expect(received.length).toBe(0);
  });

  test('unsubscribe removes a specific subscriber without affecting others', async () => {
    const a: Array<Record<string, unknown>> = [];
    const b: Array<Record<string, unknown>> = [];
    const handle = createProbeCoordinator({
      probe: async () => HEALTHY_ALL_INSTALLED,
      isElectronHost: () => true,
      now: () => 0,
    });
    const unsubA = handle.subscribe((s) => a.push(s));
    handle.subscribe((s) => b.push(s));
    unsubA();
    await handle.probe();
    expect(a.length).toBe(0);
    expect(b.length).toBe(1);
    handle.cancel();
  });

  test('web-host coordinator: Cursor target reflects probe result (no force-override)', async () => {
    // Web hosts now have a real Cursor transport, so the renderer trusts the
    // server-side probe just like every other target.
    const received: Array<Record<string, unknown>> = [];
    const handle = createProbeCoordinator({
      probe: async () => HEALTHY_ALL_INSTALLED,
      isElectronHost: () => false,
      now: () => 0,
    });
    handle.subscribe((s) => received.push(s));
    await handle.probe();
    const last = received[received.length - 1];
    expect(last?.cursor).toMatchObject({ installed: true });
    expect(last?.['claude-cowork']).toMatchObject({ installed: true });
    expect(last?.codex).toMatchObject({ installed: true });
    handle.cancel();
  });

  test('probe error does NOT ratchet lastProbedAt (immediate retry allowed)', async () => {
    let callCount = 0;
    const clock = 0;
    let shouldThrow = true;
    const handle = createProbeCoordinator({
      probe: async () => {
        callCount += 1;
        if (shouldThrow) throw new Error('boom');
        return HEALTHY_ALL_INSTALLED;
      },
      isElectronHost: () => true,
      now: () => clock,
      throttleMs: 10_000,
    });
    await handle.probe();
    expect(callCount).toBe(1);
    // No clock advance — but throttle should not gate retries after an error.
    shouldThrow = false;
    await handle.probe();
    expect(callCount).toBe(2);
    handle.cancel();
  });

  test('getTargetStates returns synchronous snapshot of latest cached state', async () => {
    const handle = createProbeCoordinator({
      probe: async () => HEALTHY_ALL_INSTALLED,
      isElectronHost: () => true,
      now: () => 0,
    });
    // Before any probe — initial state (all null).
    const initial = handle.getTargetStates();
    expect(initial['claude-cowork'].installed).toBe(null);
    await handle.probe();
    const afterProbe = handle.getTargetStates();
    expect(afterProbe['claude-cowork'].installed).toBe(true);
    handle.cancel();
  });
});
