import { describe, expect, test } from 'bun:test';

import type {
  BranchInfoResponse,
  CheckoutResponse,
  ShareTargetStatusResponse,
} from '@inkeep/open-knowledge-core';
import { RUNTIME_VERSION } from '@inkeep/open-knowledge-server';

import {
  type BranchInfoProxyDeps,
  proxyAwaitBranchSwitched,
  proxyFetchBranchInfo,
  proxyRunCheckout,
  proxyShareTargetStatus,
  resolveProjectServerOrigin,
  type ServerLockReadShape,
} from './branch-info-proxy';

/** Read a header value off a fetch init regardless of HeadersInit form. */
function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1];
  if (h) return (h as Record<string, string>)[name];
  return undefined;
}

function buildDeps(overrides: Partial<BranchInfoProxyDeps> = {}): BranchInfoProxyDeps {
  return {
    readServerLock: () => ({ pid: 4242, port: 12345 }) satisfies ServerLockReadShape,
    isProcessAlive: () => true,
    fetch: (async () => new Response(null, { status: 500 })) as typeof fetch,
    pollIntervalMs: 5,
    pollTimeoutMs: 25,
    requestTimeoutMs: 200,
    ...overrides,
  };
}

const validBranchInfo: BranchInfoResponse = {
  currentBranch: 'main',
  currentHeadSha: null,
  detached: false,
  shareTargetExists: true,
  dirtyConflicts: { conflicts: false, files: [] },
  branchIsLocal: true,
};

describe('resolveProjectServerOrigin', () => {
  test('returns http origin when the lock is live', async () => {
    const origin = await resolveProjectServerOrigin('/tmp/p', buildDeps());
    expect(origin).toBe('http://localhost:12345');
  });

  test('returns null when no lock is present after the poll window', async () => {
    const origin = await resolveProjectServerOrigin(
      '/tmp/p',
      buildDeps({ readServerLock: () => null }),
    );
    expect(origin).toBeNull();
  });

  test('returns null when port is zero (server still booting)', async () => {
    const origin = await resolveProjectServerOrigin(
      '/tmp/p',
      buildDeps({ readServerLock: () => ({ pid: 4242, port: 0 }) }),
    );
    expect(origin).toBeNull();
  });

  test('returns null when the lock-holding pid is dead', async () => {
    const origin = await resolveProjectServerOrigin(
      '/tmp/p',
      buildDeps({ isProcessAlive: () => false }),
    );
    expect(origin).toBeNull();
  });

  test('eventually picks up a lock that lands after the first poll', async () => {
    let calls = 0;
    const deps = buildDeps({
      readServerLock: () => {
        calls += 1;
        return calls >= 3 ? { pid: 1, port: 9999 } : null;
      },
    });
    const origin = await resolveProjectServerOrigin('/tmp/p', deps);
    expect(origin).toBe('http://localhost:9999');
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe('proxyFetchBranchInfo', () => {
  test('returns the validated response on a 200 with the expected shape', async () => {
    const fetchMock: typeof fetch = (async (input) => {
      const url = String(input);
      expect(url).toMatch(/branch-info\?.*branch=feat%2Ffoo/);
      expect(url).toMatch(/path=docs%2Ffoo\.md/);
      return new Response(JSON.stringify(validBranchInfo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'feat/foo', kind: 'doc', path: 'docs/foo.md' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toEqual(validBranchInfo);
  });

  // The branch-switch dialog probes branch-info with the share's kind so the
  // server runs the kind-aware `isValidBranchInfoPath` / `computeBranchInfo`
  // path. Omitting kind made the server default to 'doc', which 400s a
  // content-root folder share (empty path) before the folder-root
  // short-circuit can run.
  test('forwards kind=doc into the server query', async () => {
    let seenUrl = '';
    const fetchMock: typeof fetch = (async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify(validBranchInfo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'doc', path: 'docs/foo.md' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(seenUrl).toMatch(/[?&]kind=doc(&|$)/);
    expect(seenUrl).toMatch(/path=docs%2Ffoo\.md/);
  });

  test('forwards kind=folder into the server query', async () => {
    let seenUrl = '';
    const fetchMock: typeof fetch = (async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify(validBranchInfo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'folder', path: 'docs/guides' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(seenUrl).toMatch(/[?&]kind=folder(&|$)/);
    expect(seenUrl).toMatch(/path=docs%2Fguides/);
  });

  // Content-root folder share: empty path + kind=folder. The server's
  // folder-root short-circuit returns shareTargetExists:true only when both
  // arrive on the wire — a defaulted kind=doc would 400 on the empty path.
  test('forwards kind=folder with an empty path for a content-root folder share', async () => {
    let seenUrl = '';
    const fetchMock: typeof fetch = (async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify(validBranchInfo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'folder', path: '' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(seenUrl).toMatch(/[?&]kind=folder(&|$)/);
    // Empty path serializes to a bare `path=` so the server reads `''`, not a
    // missing param — `isValidBranchInfoPath('', 'folder')` is the success arm.
    expect(seenUrl).toMatch(/[?&]path=(&|$)/);
  });

  // every main-process /api request carries the desktop-main version
  // headers (v1 wire contract).
  test('sends client version headers (kind=desktop-main) on the branch-info GET', async () => {
    let seen: RequestInit | undefined;
    const fetchMock: typeof fetch = (async (_input, init) => {
      seen = init;
      return new Response(JSON.stringify(validBranchInfo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'doc', path: 'a.md' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(headerOf(seen, 'x-ok-client-protocol')).toBe('1');
    expect(headerOf(seen, 'x-ok-client-kind')).toBe('desktop-main');
    expect(headerOf(seen, 'x-ok-client-runtime')).toBe(RUNTIME_VERSION);
  });

  test('returns null when the server returns non-2xx', async () => {
    const result = await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'doc', path: 'a.md' },
      buildDeps({ fetch: (async () => new Response(null, { status: 500 })) as typeof fetch }),
    );
    expect(result).toBeNull();
  });

  test('returns null when the response shape is invalid', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify({ bogus: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'doc', path: 'a.md' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toBeNull();
  });

  test('returns null when the server lock never resolves', async () => {
    const result = await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'doc', path: 'a.md' },
      buildDeps({ readServerLock: () => null }),
    );
    expect(result).toBeNull();
  });

  test('returns null when fetch throws (network error / timeout)', async () => {
    const result = await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'doc', path: 'a.md' },
      buildDeps({
        fetch: (async () => {
          throw new Error('boom');
        }) as typeof fetch,
      }),
    );
    expect(result).toBeNull();
  });
});

describe('proxyRunCheckout', () => {
  test('serializes branch in the JSON body and validates the success shape', async () => {
    let capturedBody: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = (async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      capturedInit = init;
      const okBody: CheckoutResponse = { ok: true };
      return new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await proxyRunCheckout(
      { projectPath: '/tmp/p', branch: 'feat/foo' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toEqual({ ok: true });
    expect(capturedBody).toBeDefined();
    expect(JSON.parse(capturedBody as string)).toEqual({ branch: 'feat/foo' });
    // version headers ride alongside the preserved content-type on the POST.
    expect(headerOf(capturedInit, 'x-ok-client-kind')).toBe('desktop-main');
    expect(headerOf(capturedInit, 'content-type')).toBe('application/json');
  });

  test('returns the discriminated dirty-conflict shape verbatim', async () => {
    const body: CheckoutResponse = {
      ok: false,
      reason: 'dirty-conflict',
      files: ['a.md', 'b.md'],
    };
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyRunCheckout(
      { projectPath: '/tmp/p', branch: 'main' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toEqual(body);
  });

  test('returns null when the schema rejects an unknown failure reason', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify({ ok: false, reason: 'mystery' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyRunCheckout(
      { projectPath: '/tmp/p', branch: 'main' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toBeNull();
  });

  test('omits fastForward from the body unless requested', async () => {
    let capturedBody: string | undefined;
    const fetchMock: typeof fetch = (async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ ok: true } satisfies CheckoutResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await proxyRunCheckout(
      { projectPath: '/tmp/p', branch: 'main' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(JSON.parse(capturedBody as string)).toEqual({ branch: 'main' });
  });

  test('threads fastForward:true into the checkout body (Switch and update branch)', async () => {
    let capturedBody: string | undefined;
    const fetchMock: typeof fetch = (async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ ok: true } satisfies CheckoutResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await proxyRunCheckout(
      { projectPath: '/tmp/p', branch: 'feat/x', fastForward: true },
      buildDeps({ fetch: fetchMock }),
    );
    expect(JSON.parse(capturedBody as string)).toEqual({ branch: 'feat/x', fastForward: true });
  });

  test('returns the ff-diverged reason verbatim so the dialog can show the honest note', async () => {
    const body: CheckoutResponse = { ok: false, reason: 'ff-diverged' };
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyRunCheckout(
      { projectPath: '/tmp/p', branch: 'feat/x', fastForward: true },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toEqual(body);
  });
});

describe('proxyShareTargetStatus', () => {
  test('POSTs branch/path/kind and returns the on-origin verdict', async () => {
    let capturedBody: string | undefined;
    let capturedUrl = '';
    const fetchMock: typeof fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? '');
      const okBody: ShareTargetStatusResponse = { verdict: 'on-origin' };
      return new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await proxyShareTargetStatus(
      { projectPath: '/tmp/p', branch: 'feat/x', path: 'docs/a.md', kind: 'doc' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toEqual({ verdict: 'on-origin' });
    expect(capturedUrl).toContain('/api/share/target-status');
    expect(JSON.parse(capturedBody as string)).toEqual({
      branch: 'feat/x',
      path: 'docs/a.md',
      kind: 'doc',
    });
  });

  test('returns the renamed verdict with renamedTo verbatim', async () => {
    const body: ShareTargetStatusResponse = { verdict: 'renamed', renamedTo: 'guides/a.md' };
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyShareTargetStatus(
      { projectPath: '/tmp/p', branch: 'main', path: 'docs/a.md', kind: 'doc' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toEqual(body);
  });

  test('returns null on a non-2xx transport failure (dialog falls back to today guidance)', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(null, { status: 500 })) as typeof fetch;
    const result = await proxyShareTargetStatus(
      { projectPath: '/tmp/p', branch: 'main', path: '', kind: 'folder' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toBeNull();
  });

  test('coerces a malformed 200 body to the unknown verdict (never throws)', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify({ verdict: 'bogus-future-value' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyShareTargetStatus(
      { projectPath: '/tmp/p', branch: 'main', path: 'docs/a.md', kind: 'doc' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toEqual({ verdict: 'unknown' });
  });

  test('returns null when the server lock never resolves', async () => {
    const result = await proxyShareTargetStatus(
      { projectPath: '/tmp/p', branch: 'main', path: 'docs/a.md', kind: 'doc' },
      buildDeps({ readServerLock: () => null }),
    );
    expect(result).toBeNull();
  });
});

describe('proxyAwaitBranchSwitched', () => {
  test('resolves with match when the first server-info poll already shows the expected branch', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify({ serverInstanceId: 'sid', currentBranch: 'feat/foo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyAwaitBranchSwitched(
      { projectPath: '/tmp/p', branch: 'feat/foo', timeoutMs: 200 },
      buildDeps({ fetch: fetchMock, pollIntervalMs: 5 }),
    );
    expect(result).toEqual({ ok: true });
  });

  test('polls until the server-info currentBranch matches', async () => {
    let polls = 0;
    const fetchMock: typeof fetch = (async () => {
      polls += 1;
      const currentBranch = polls >= 3 ? 'feat/foo' : 'main';
      return new Response(JSON.stringify({ serverInstanceId: 'sid', currentBranch }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await proxyAwaitBranchSwitched(
      { projectPath: '/tmp/p', branch: 'feat/foo', timeoutMs: 2_000 },
      buildDeps({ fetch: fetchMock, pollIntervalMs: 5 }),
    );
    expect(result).toEqual({ ok: true });
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  test('resolves with timeout when no poll matches before the deadline', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify({ serverInstanceId: 'sid', currentBranch: 'main' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyAwaitBranchSwitched(
      { projectPath: '/tmp/p', branch: 'feat/foo', timeoutMs: 50 },
      buildDeps({ fetch: fetchMock, pollIntervalMs: 5 }),
    );
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  test('resolves with project-not-open when the server lock never resolves', async () => {
    const result = await proxyAwaitBranchSwitched(
      { projectPath: '/tmp/p', branch: 'feat/foo', timeoutMs: 50 },
      buildDeps({ readServerLock: () => null }),
    );
    expect(result).toEqual({ ok: false, reason: 'project-not-open' });
  });

  test('treats non-2xx server-info responses as not-yet-matched (keeps polling, eventually times out)', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(null, { status: 500 })) as typeof fetch;
    const result = await proxyAwaitBranchSwitched(
      { projectPath: '/tmp/p', branch: 'feat/foo', timeoutMs: 50 },
      buildDeps({ fetch: fetchMock, pollIntervalMs: 5 }),
    );
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  test('treats malformed server-info responses as not-yet-matched (transient skew)', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify({ bogus: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyAwaitBranchSwitched(
      { projectPath: '/tmp/p', branch: 'feat/foo', timeoutMs: 50 },
      buildDeps({ fetch: fetchMock, pollIntervalMs: 5 }),
    );
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  test('preserves slashed branch names verbatim in the comparison', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify({ serverInstanceId: 'sid', currentBranch: 'release/v1.2.3' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyAwaitBranchSwitched(
      { projectPath: '/tmp/p', branch: 'release/v1.2.3', timeoutMs: 200 },
      buildDeps({ fetch: fetchMock, pollIntervalMs: 5 }),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('AbortSignal cancellation', () => {
  test('resolveProjectServerOrigin bails early when the signal aborts mid-poll', async () => {
    const controller = new AbortController();
    let calls = 0;
    const deps = buildDeps({
      readServerLock: () => {
        calls += 1;
        // Abort after a couple of polls so the busy-wait can't hit the
        // full deadline.
        if (calls === 2) controller.abort();
        return null;
      },
      pollIntervalMs: 1,
      pollTimeoutMs: 10_000,
    });
    const start = Date.now();
    const origin = await resolveProjectServerOrigin('/tmp/p', deps, controller.signal);
    const elapsed = Date.now() - start;
    expect(origin).toBeNull();
    // The full deadline is 10s; aborting after ~2 polls should resolve in
    // well under a second.
    expect(elapsed).toBeLessThan(500);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('resolveProjectServerOrigin returns null synchronously when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const deps = buildDeps({
      readServerLock: () => {
        calls += 1;
        return null;
      },
      pollTimeoutMs: 10_000,
    });
    const origin = await resolveProjectServerOrigin('/tmp/p', deps, controller.signal);
    expect(origin).toBeNull();
    expect(calls).toBe(0);
  });

  test('proxyFetchBranchInfo returns null without fetching when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    const result = await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'doc', path: 'a.md' },
      buildDeps({
        fetch: (async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify(validBranchInfo), { status: 200 });
        }) as typeof fetch,
      }),
      controller.signal,
    );
    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test('proxyRunCheckout returns null without fetching when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    const result = await proxyRunCheckout(
      { projectPath: '/tmp/p', branch: 'main' },
      buildDeps({
        fetch: (async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch,
      }),
      controller.signal,
    );
    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test('proxyAwaitBranchSwitched terminates with timeout when the signal aborts mid-poll', async () => {
    const controller = new AbortController();
    let polls = 0;
    const fetchMock: typeof fetch = (async () => {
      polls += 1;
      if (polls === 2) controller.abort();
      return new Response(JSON.stringify({ serverInstanceId: 'sid', currentBranch: 'main' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const start = Date.now();
    const result = await proxyAwaitBranchSwitched(
      { projectPath: '/tmp/p', branch: 'feat/foo', timeoutMs: 10_000 },
      buildDeps({ fetch: fetchMock, pollIntervalMs: 1 }),
      controller.signal,
    );
    const elapsed = Date.now() - start;
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(elapsed).toBeLessThan(500);
  });

  test('proxy functions work normally without a signal (back-compat)', async () => {
    const fetchMock: typeof fetch = (async () =>
      new Response(JSON.stringify(validBranchInfo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await proxyFetchBranchInfo(
      { projectPath: '/tmp/p', branch: 'main', kind: 'doc', path: 'a.md' },
      buildDeps({ fetch: fetchMock }),
    );
    expect(result).toEqual(validBranchInfo);
  });
});
