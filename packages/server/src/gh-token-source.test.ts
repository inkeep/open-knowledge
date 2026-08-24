import { describe, expect, test } from 'vitest';
import { createGhTokenSource } from './gh-token-source.ts';
import type { DetectGhFn } from './github-permissions.ts';

/** A `detectGh` stub that records call count and returns a scripted result. */
function makeDetectGh(result: ReturnType<DetectGhFn>): { fn: DetectGhFn; calls: () => number } {
  let calls = 0;
  return {
    fn: (_host?: string) => {
      calls++;
      return result;
    },
    calls: () => calls,
  };
}

/** A mutable clock so TTL expiry can be driven deterministically. */
function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** A `detectGh` fake that records each (host, login) request and answers via `behavior`. */
function makeRecordingDetectGh(
  behavior: (host?: string, login?: string) => ReturnType<DetectGhFn>,
): { fn: DetectGhFn; calls: () => Array<{ host?: string; login?: string }> } {
  const calls: Array<{ host?: string; login?: string }> = [];
  return {
    fn: (host?: string, options?: { login?: string }) => {
      const login = options?.login;
      calls.push({ host, login });
      return behavior(host, login);
    },
    calls: () => calls,
  };
}

describe('createGhTokenSource', () => {
  test('returns null throughout when no detectGh is injected', () => {
    const source = createGhTokenSource(undefined);
    expect(source.get('github.com')).toBeNull();
  });

  test('returns null when gh is unavailable', () => {
    const detect = makeDetectGh({ available: false });
    const source = createGhTokenSource(detect.fn);
    expect(source.get('github.com')).toBeNull();
  });

  test('returns null when gh is available but carries no token', () => {
    // Unrepresentable for a TYPED implementation (the union makes
    // `available: true` imply a token), but this seam accepts injected
    // implementations from untyped callers too — the runtime guard must
    // degrade a tokenless "available" to no-credential, not relay undefined.
    const detect = makeDetectGh({ available: true } as ReturnType<DetectGhFn>);
    const source = createGhTokenSource(detect.fn);
    expect(source.get('github.com')).toBeNull();
  });

  test('resolves the token host-scoped when gh is authenticated', () => {
    const detect = makeDetectGh({ available: true, token: 'gho_abc' });
    const source = createGhTokenSource(detect.fn);
    expect(source.get('github.com')).toEqual({ token: 'gho_abc', host: 'github.com' });
  });

  test('caches within the TTL — only one detectGh call', () => {
    const detect = makeDetectGh({ available: true, token: 'gho_abc' });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, { ttlMs: 60_000, now: clock.now });

    source.get('github.com');
    clock.advance(59_000);
    source.get('github.com');

    expect(detect.calls()).toBe(1);
  });

  test('re-resolves after the TTL expires', () => {
    const detect = makeDetectGh({ available: true, token: 'gho_abc' });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, { ttlMs: 60_000, now: clock.now });

    source.get('github.com');
    clock.advance(60_001);
    source.get('github.com');

    expect(detect.calls()).toBe(2);
  });

  test('caches the negative result too (no token) within the TTL', () => {
    const detect = makeDetectGh({ available: false });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, { ttlMs: 60_000, now: clock.now });

    expect(source.get('github.com')).toBeNull();
    clock.advance(30_000);
    expect(source.get('github.com')).toBeNull();

    expect(detect.calls()).toBe(1);
  });

  test('invalidate() forces the next get to re-resolve', () => {
    const detect = makeDetectGh({ available: true, token: 'gho_abc' });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, { ttlMs: 60_000, now: clock.now });

    source.get('github.com');
    source.invalidate();
    source.get('github.com');

    expect(detect.calls()).toBe(2);
  });
});

describe('createGhTokenSource with a requested account', () => {
  test('forwards the login to detectGh and names the account that produced the token', () => {
    const detect = makeRecordingDetectGh(() => ({
      available: true,
      token: 'gho_alice',
      resolvedLogin: 'alice',
      fallback: false,
    }));
    const source = createGhTokenSource(detect.fn);

    expect(source.get('github.com', 'alice')).toEqual({
      token: 'gho_alice',
      host: 'github.com',
      login: 'alice',
    });
    expect(detect.calls()).toEqual([{ host: 'github.com', login: 'alice' }]);
  });

  test('keys the cache per account — bare-host and per-login entries are independent', () => {
    const detect = makeRecordingDetectGh((_host, login) => {
      if (login === 'alice')
        return { available: true, token: 'gho_alice', resolvedLogin: 'alice', fallback: false };
      if (login === 'bob')
        return { available: true, token: 'gho_bob', resolvedLogin: 'bob', fallback: false };
      return { available: true, token: 'gho_active' };
    });
    const source = createGhTokenSource(detect.fn);

    expect(source.get('github.com')?.token).toBe('gho_active');
    expect(source.get('github.com', 'alice')?.token).toBe('gho_alice');
    expect(source.get('github.com', 'bob')?.token).toBe('gho_bob');

    // Repeat gets serve each key's own cached entry, not each other's.
    expect(source.get('github.com')?.token).toBe('gho_active');
    expect(source.get('github.com', 'alice')?.token).toBe('gho_alice');
    expect(source.get('github.com', 'bob')?.token).toBe('gho_bob');
    expect(detect.calls()).toHaveLength(3);
  });

  test('a fallback is cached only briefly, so signing the declared account in takes effect on the next resolution', () => {
    const known = new Map<string, string>();
    const detect = makeRecordingDetectGh((_host, login) => {
      const token = login ? known.get(login) : undefined;
      if (login && token) return { available: true, token, resolvedLogin: login, fallback: false };
      return login
        ? { available: true, token: 'gho_active', fallback: true }
        : { available: true, token: 'gho_active' };
    });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, {
      ttlMs: 60_000,
      fallbackTtlMs: 5_000,
      now: clock.now,
    });

    // alice is not signed in: the active account's token answers, unattributed —
    // the relay value must not claim the account that was asked for.
    expect(source.get('github.com', 'alice')).toEqual({ token: 'gho_active', host: 'github.com' });
    expect(source.get('github.com', 'alice')).not.toHaveProperty('login');

    // Within the short window the fallback serves from cache: a push cycle's
    // burst of handles costs one spawn.
    clock.advance(4_999);
    expect(source.get('github.com', 'alice')?.token).toBe('gho_active');
    expect(detect.calls()).toHaveLength(1);

    // The user signs alice in. Past the short TTL — far inside the full TTL —
    // the next get re-resolves and alice's own token lands under alice's key.
    known.set('alice', 'gho_alice');
    clock.advance(2);
    expect(source.get('github.com', 'alice')).toEqual({
      token: 'gho_alice',
      host: 'github.com',
      login: 'alice',
    });
    expect(detect.calls()).toHaveLength(2);
  });

  // The honored/miss decision routes through the shared login comparison, so
  // an implementation that answers with GitHub's canonical casing for a
  // differently-cased request counts as honored — it gets the FULL TTL, not
  // the escalating miss window. Under an exact-match comparison this key
  // would re-spawn gh every few seconds for a correctly-configured remote.
  test('a casing-only difference in the resolved login is honored, not a miss', () => {
    const detect = makeRecordingDetectGh(() => ({
      available: true,
      token: 'gho_alice',
      resolvedLogin: 'alice',
      fallback: false,
    }));
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, {
      ttlMs: 60_000,
      fallbackTtlMs: 5_000,
      now: clock.now,
    });

    expect(source.get('github.com', 'Alice')?.token).toBe('gho_alice');
    expect(detect.calls()).toHaveLength(1);

    // Past the miss window but far inside the full TTL: an honored entry is
    // still cached, so no second spawn.
    clock.advance(10_000);
    expect(source.get('github.com', 'Alice')?.token).toBe('gho_alice');
    expect(detect.calls()).toHaveLength(1);
  });

  test('a standing miss backs off — the fallback window doubles per resolution up to the full TTL', () => {
    const detect = makeRecordingDetectGh((_host, login) =>
      login
        ? { available: true, token: 'gho_active', fallback: true }
        : { available: true, token: 'gho_active' },
    );
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, {
      ttlMs: 60_000,
      fallbackTtlMs: 5_000,
      now: clock.now,
    });

    source.get('github.com', 'alice'); // miss #1 → 5s window
    clock.advance(5_001);
    source.get('github.com', 'alice'); // miss #2 → 10s window
    expect(detect.calls()).toHaveLength(2);

    // Inside the doubled window the standing miss serves from cache instead
    // of re-paying the failing candidate walk.
    clock.advance(5_001);
    source.get('github.com', 'alice');
    expect(detect.calls()).toHaveLength(2);

    clock.advance(5_000); // now past the 10s window
    source.get('github.com', 'alice'); // miss #3 → 20s window
    expect(detect.calls()).toHaveLength(3);

    // The escalation is capped at the full TTL: after many misses the window
    // never exceeds what an honored entry would get.
    for (let i = 0; i < 6; i += 1) {
      clock.advance(60_001);
      source.get('github.com', 'alice');
    }
    const callsAtCap = detect.calls().length;
    clock.advance(59_000);
    source.get('github.com', 'alice');
    expect(detect.calls()).toHaveLength(callsAtCap);
    clock.advance(1_001);
    source.get('github.com', 'alice');
    expect(detect.calls()).toHaveLength(callsAtCap + 1);
  });

  test('invalidate() resets the fallback backoff along with the cache', () => {
    const detect = makeRecordingDetectGh((_host, login) =>
      login
        ? { available: true, token: 'gho_active', fallback: true }
        : { available: true, token: 'gho_active' },
    );
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, {
      ttlMs: 60_000,
      fallbackTtlMs: 5_000,
      now: clock.now,
    });

    source.get('github.com', 'alice'); // miss #1 → 5s window
    clock.advance(5_001);
    source.get('github.com', 'alice'); // miss #2 → would be a 10s window
    source.invalidate();

    // Post-invalidate the streak starts over: the fresh miss gets the fast
    // initial window again, so an explicit credential-change signal recovers
    // as quickly as the very first resolution did.
    source.get('github.com', 'alice'); // miss #1 again → 5s window
    clock.advance(5_001);
    source.get('github.com', 'alice');
    expect(detect.calls()).toHaveLength(4);
  });

  // Constructed the way production constructs it (no TTL options) so the
  // shipped initial fallback window is pinned — replacing the default with
  // the full TTL would silently restore the minute-long wrong-account window
  // the short TTL exists to prevent.
  test('the default initial fallback window is 5s', () => {
    const known = new Map<string, string>();
    const detect = makeRecordingDetectGh((_host, login) => {
      const token = login ? known.get(login) : undefined;
      if (login && token) return { available: true, token, resolvedLogin: login, fallback: false };
      return { available: true, token: 'gho_active', ...(login ? { fallback: true } : {}) };
    });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, { now: clock.now });

    expect(source.get('github.com', 'alice')?.login).toBeUndefined();
    known.set('alice', 'gho_alice');
    clock.advance(5_001);
    expect(source.get('github.com', 'alice')?.login).toBe('alice');
  });

  test('an honored account entry keeps the full TTL — only unhonored results expire early', () => {
    const detect = makeRecordingDetectGh((_host, login) =>
      login
        ? { available: true, token: 'gho_alice', resolvedLogin: login, fallback: false }
        : { available: false },
    );
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, {
      ttlMs: 60_000,
      fallbackTtlMs: 5_000,
      now: clock.now,
    });

    source.get('github.com', 'alice');
    clock.advance(30_000);
    expect(source.get('github.com', 'alice')?.token).toBe('gho_alice');
    expect(detect.calls()).toHaveLength(1);
  });

  test('a no-credential answer under an account key also expires on the short TTL', () => {
    const known = new Map<string, string>();
    const detect = makeRecordingDetectGh((_host, login) => {
      const token = login ? known.get(login) : undefined;
      if (login && token) return { available: true, token, resolvedLogin: login, fallback: false };
      return { available: false };
    });
    const clock = makeClock();
    const source = createGhTokenSource(detect.fn, {
      ttlMs: 60_000,
      fallbackTtlMs: 5_000,
      now: clock.now,
    });

    expect(source.get('github.com', 'alice')).toBeNull();

    // Signing in is the recovery this short window exists for.
    known.set('alice', 'gho_alice');
    clock.advance(5_001);
    expect(source.get('github.com', 'alice')?.login).toBe('alice');
  });
});
