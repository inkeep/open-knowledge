import { describe, expect, mock, test } from 'bun:test';
import { runKeyringSmoke } from './keyring-smoke.ts';

interface FakeEntryCalls {
  constructed: Array<{ service: string; account: string }>;
  setPassword: string[];
  getPassword: number;
  deletePassword: number;
}

function makeFakeKeyring(
  opts: {
    readValue?: string | null | ((written: string | null) => string | null);
    throwOnConstruct?: boolean;
    throwOnSetPassword?: boolean;
  } = {},
): { mod: typeof import('@napi-rs/keyring'); calls: FakeEntryCalls } {
  const calls: FakeEntryCalls = {
    constructed: [],
    setPassword: [],
    getPassword: 0,
    deletePassword: 0,
  };
  let written: string | null = null;

  class FakeEntry {
    constructor(service: string, account: string) {
      calls.constructed.push({ service, account });
      if (opts.throwOnConstruct) throw new Error('entry construct failed');
    }
    setPassword(value: string): void {
      if (opts.throwOnSetPassword) throw new Error('setPassword failed');
      calls.setPassword.push(value);
      written = value;
    }
    getPassword(): string | null {
      calls.getPassword++;
      if (typeof opts.readValue === 'function') return opts.readValue(written);
      if (opts.readValue !== undefined) return opts.readValue;
      return written;
    }
    deletePassword(): void {
      calls.deletePassword++;
      written = null;
    }
  }

  return {
    mod: { Entry: FakeEntry as unknown as typeof import('@napi-rs/keyring').Entry },
    calls,
  };
}

describe('runKeyringSmoke', () => {
  test('success path: constructs Entry, set/get/delete round-trip, returns ok:true', async () => {
    const { mod, calls } = makeFakeKeyring();
    let tick = 1000;
    const result = await runKeyringSmoke({
      loadKeyring: () => Promise.resolve(mod),
      now: () => (tick += 5),
    });
    expect(result.ok).toBe(true);
    expect(result.backend).toBe('keyring');
    expect(result.error).toBeUndefined();
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.timestamp).toBe('string');

    expect(calls.constructed).toHaveLength(1);
    expect(calls.constructed[0]).toEqual({
      service: 'open-knowledge-smoke',
      account: 'test-user',
    });
    expect(calls.setPassword).toHaveLength(1);
    expect(calls.getPassword).toBe(1);
    expect(calls.deletePassword).toBe(1);
  });

  test('load failure: loadKeyring throws, no Entry methods invoked', async () => {
    const loadKeyring = mock(() => Promise.reject(new Error('module not found')));
    const result = await runKeyringSmoke({ loadKeyring });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('module not found');
    expect(result.backend).toBeUndefined();
    expect(typeof result.durationMs).toBe('number');
    expect(loadKeyring).toHaveBeenCalledTimes(1);
  });

  test('constructor failure: Entry throws, cleanup skipped, returns error', async () => {
    const { mod, calls } = makeFakeKeyring({ throwOnConstruct: true });
    const result = await runKeyringSmoke({ loadKeyring: () => Promise.resolve(mod) });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('entry construct failed');
    // Entry ctor ran once but threw; no subsequent methods called
    expect(calls.setPassword).toHaveLength(0);
    expect(calls.getPassword).toBe(0);
    expect(calls.deletePassword).toBe(0);
  });

  test('read-mismatch: getPassword returns different value, error includes mismatch diagnostic', async () => {
    const { mod, calls } = makeFakeKeyring({ readValue: 'wrong-value' });
    const result = await runKeyringSmoke({ loadKeyring: () => Promise.resolve(mod) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('read mismatch');
    expect(result.error).toContain('wrong-value');
    // Cleanup runs in finally even on mismatch
    expect(calls.deletePassword).toBe(1);
  });

  test('setPassword failure: returns error; cleanup still runs', async () => {
    const { mod, calls } = makeFakeKeyring({ throwOnSetPassword: true });
    const result = await runKeyringSmoke({ loadKeyring: () => Promise.resolve(mod) });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('setPassword failed');
    // Constructor succeeded, so finally block runs deletePassword for cleanup
    expect(calls.deletePassword).toBe(1);
  });

  test('timestamp is ISO-8601', async () => {
    const { mod } = makeFakeKeyring();
    const result = await runKeyringSmoke({ loadKeyring: () => Promise.resolve(mod) });
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });

  test('uses injected now() for duration measurement', async () => {
    const { mod } = makeFakeKeyring();
    const ticks = [1000, 1025];
    const result = await runKeyringSmoke({
      loadKeyring: () => Promise.resolve(mod),
      now: () => ticks.shift() ?? 9999,
    });
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);
  });
});
