import { AGENT_REGISTRY, type ApplyReport, type HostSnapshot } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { applyAgentConnectionIntents } from './agent-connections.ts';

const SNAPSHOT: HostSnapshot = {
  probes: { env: 'local-web', satisfiers: {} },
  detection: { detected: ['claude'], probed: true },
};

const EMPTY_REPORT: ApplyReport = { actions: [], conflicts: [], withheld: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('applyAgentConnectionIntents', () => {
  test('uses the desktop batch bridge when it is available', async () => {
    const apply = vi.fn(async () => ({
      ok: true as const,
      report: EMPTY_REPORT,
      snapshot: SNAPSHOT,
    }));
    vi.stubGlobal('window', { okDesktop: { agentIntegrations: { apply } } });
    const intent = {
      satisfierId: AGENT_REGISTRY.claude.satisfiers[0].id,
      desired: 'present' as const,
    };

    const result = await applyAgentConnectionIntents([intent]);

    expect(apply).toHaveBeenCalledWith({ intents: [intent] });
    expect(result).toEqual({ ok: true, report: EMPTY_REPORT, snapshot: SNAPSHOT });
  });

  test('posts to the local-web twin and validates its snapshot', async () => {
    vi.stubGlobal('window', {});
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ actions: [], conflicts: [], withheld: [], snapshot: SNAPSHOT }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetch);

    const result = await applyAgentConnectionIntents([]);

    expect(fetch).toHaveBeenCalledWith('/api/agent-integrations/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ intents: [] }),
    });
    expect(result.ok).toBe(true);
    expect(result.snapshot).toEqual(SNAPSHOT);
  });

  test('keeps the post-apply snapshot when the host reports a planning conflict', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              actions: [],
              conflicts: [
                {
                  kind: 'unknown-satisfier',
                  satisfierIds: ['new-agent/mcp/user/config-entry'],
                  agentIds: [],
                },
              ],
              withheld: ['new-agent/mcp/user/config-entry'],
              snapshot: SNAPSHOT,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    const result = await applyAgentConnectionIntents([]);

    expect(result.ok).toBe(false);
    expect(result.report.conflicts[0]?.kind).toBe('unknown-satisfier');
    expect(result.snapshot).toEqual(SNAPSHOT);
  });
});

describe('what a refused desktop apply carries back', () => {
  test('keeps the host error text and the unavailable flag', async () => {
    const apply = vi.fn(async () => ({
      ok: false as const,
      error: 'Managing AI tool connections is unavailable in this build.',
      unavailable: true,
      report: EMPTY_REPORT,
      snapshot: SNAPSHOT,
    }));
    vi.stubGlobal('window', { okDesktop: { agentIntegrations: { apply } } });

    const result = await applyAgentConnectionIntents([]);

    expect(result).toEqual({
      ok: false,
      report: EMPTY_REPORT,
      snapshot: SNAPSHOT,
      error: 'Managing AI tool connections is unavailable in this build.',
      unavailable: true,
    });
  });

  test('keeps a thrown bridge error as text', async () => {
    const apply = vi.fn(async () => {
      throw new Error('bridge exploded');
    });
    vi.stubGlobal('window', { okDesktop: { agentIntegrations: { apply } } });

    const result = await applyAgentConnectionIntents([]);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('bridge exploded');
    expect(result.unavailable).toBeUndefined();
  });
});

describe('what a failed local-web apply carries back', () => {
  test('a network failure keeps the thrown message', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    const result = await applyAgentConnectionIntents([]);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection refused');
  });

  test('a non-2xx response names the status', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' })),
    );

    const result = await applyAgentConnectionIntents([]);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 503 Service Unavailable');
  });

  test('a body that is not JSON keeps the parse error', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200 })),
    );

    const result = await applyAgentConnectionIntents([]);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('a response of the wrong shape names the fields that drifted', async () => {
    vi.stubGlobal('window', {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ actions: 'no' }), { status: 200 })),
    );

    const result = await applyAgentConnectionIntents([]);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Unexpected response shape at .*actions/);
  });
});
