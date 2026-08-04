import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';
import { getFreeLoopbackPort } from './loopback-rig-test-helpers.ts';
import { mountMcpAndApi } from './mcp-mount.ts';

/**
 * /healthz + /readyz over the composed listener. The load-bearing property is
 * the admission EXEMPTION: orchestrator probes arrive with an IP Host header,
 * no Origin, and often through a proxy that adds forwarding headers — every
 * other surface refuses those, the health surface must not.
 */

let tmpRoot: string;
let booted: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-health-'));
  booted = await bootCompositionRig(mkdtempSync(resolve(tmpRoot, 'proj-')));
}, 60_000);

afterAll(async () => {
  await booted?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('/healthz', () => {
  test('answers 200 ok with no-store, independent of readiness', async () => {
    const res = await fetch(`http://127.0.0.1:${booted.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('is exempt from the Host gate (orchestrator probes send IP hosts)', async () => {
    const res = await rawRequest(booted.port, '/healthz', {
      headers: { Host: '10.0.0.7:8080' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
  });

  test('is exempt from the forwarding-header tripwire (probes traverse proxies)', async () => {
    const res = await rawRequest(booted.port, '/healthz', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(res.status).toBe(200);
  });

  test('non-GET is refused with 405 and an Allow header', async () => {
    const res = await rawRequest(booted.port, '/healthz', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
    expect(parseProblem(res.body).type).toBe('urn:ok:error:method-not-allowed');
  });

  test('query strings do not break the exact match', async () => {
    const res = await fetch(`http://127.0.0.1:${booted.port}/healthz?probe=1`);
    expect(res.status).toBe(200);
  });
});

describe('/readyz', () => {
  test('reports 200 with the single-shaped body once init settles', async () => {
    await booted.ready;
    const res = await fetch(`http://127.0.0.1:${booted.port}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; status: string; degraded: string[] };
    expect(body.ready).toBe(true);
    expect(body.status).toBe('ready');
    expect(Array.isArray(body.degraded)).toBe(true);
  });

  test('during boot answers either 503 not-ready or 200 ready, never a gate refusal', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-readyz-race-'));
    try {
      const racing = await bootCompositionRig(tmp);
      try {
        // No `await racing.ready` — init may or may not have settled; the pin
        // is that the surface is mounted and shaped correctly from the first
        // instant the listener exists.
        const res = await fetch(`http://127.0.0.1:${racing.port}/readyz`);
        expect([200, 503]).toContain(res.status);
        const body = (await res.json()) as { ready: boolean };
        expect(body.ready).toBe(res.status === 200);
        await racing.ready;
        const settled = await fetch(`http://127.0.0.1:${racing.port}/readyz`);
        expect(settled.status).toBe(200);
      } finally {
        await racing.destroy();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test('is exempt from the Host gate like /healthz', async () => {
    const res = await rawRequest(booted.port, '/readyz', {
      headers: { Host: 'kb.internal:8080' },
    });
    expect(res.status).toBe(200);
  });

  test('destroy() flips readiness to draining before the listener closes', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-readyz-drain-'));
    try {
      const draining = await bootCompositionRig(tmp);
      await draining.ready;

      // No await: `readinessState = 'draining'` is the first synchronous
      // statement of destroy(), so any probe dispatched after this call
      // observes either 503 (listener still up) or a refused connection
      // (listener already closed) — never a 200 that routes traffic in.
      const destroyed = draining.destroy();
      let probe: { status: number; body?: { ready: boolean; status: string } } | 'refused';
      try {
        const res = await fetch(`http://127.0.0.1:${draining.port}/readyz`);
        probe = {
          status: res.status,
          body: (await res.json()) as { ready: boolean; status: string },
        };
      } catch {
        probe = 'refused';
      }
      await destroyed;

      if (probe !== 'refused') {
        expect(probe.status).toBe(503);
        expect(probe.body?.ready).toBe(false);
        expect(probe.body?.status).toBe('draining');
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('/readyz provider states (mounted harness)', () => {
  // bootServer only ever produces pending→ready|failed→draining transitions
  // organically; the failed and draining response shapes are pinned here at
  // the mount level with a canned provider so the wire contract cannot
  // silently drift.
  const fakeLog = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => fakeLog,
  };
  const fakeHocuspocus = {
    hooks: async () => {},
    handleConnection: () => ({ handleMessage: () => {}, handleClose: () => {} }),
  } as unknown as Hocuspocus;

  async function probeWithReadiness(
    readiness: 'ready' | 'failed' | 'draining' | undefined,
  ): Promise<{ status: number; body: { ready: boolean; status: string; degraded: string[] } }> {
    const httpServer = createServer();
    const mount = mountMcpAndApi({
      httpServer,
      hocuspocus: fakeHocuspocus,
      log: fakeLog as never,
      ...(readiness === undefined
        ? {}
        : { health: { readiness: () => readiness, degraded: () => ['shadow-repo'] } }),
    });
    const port = await getFreeLoopbackPort();
    await new Promise<void>((r) => httpServer.listen(port, '127.0.0.1', () => r()));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      return {
        status: res.status,
        body: (await res.json()) as { ready: boolean; status: string; degraded: string[] },
      };
    } finally {
      await mount.shutdown();
      await new Promise<void>((r) => mount.wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  }

  test('failed init reports 503 with status failed and an empty degraded list', async () => {
    const probe = await probeWithReadiness('failed');
    expect(probe.status).toBe(503);
    expect(probe.body).toEqual({ ready: false, status: 'failed', degraded: [] });
  });

  test('draining reports 503 with status draining', async () => {
    const probe = await probeWithReadiness('draining');
    expect(probe.status).toBe(503);
    expect(probe.body).toEqual({ ready: false, status: 'draining', degraded: [] });
  });

  test('ready passes the degraded list through into the 200 body', async () => {
    const probe = await probeWithReadiness('ready');
    expect(probe.status).toBe(200);
    expect(probe.body).toEqual({ ready: true, status: 'ready', degraded: ['shadow-repo'] });
  });

  test('a throwing provider yields a structured 500, not the router default', async () => {
    const httpServer = createServer();
    const mount = mountMcpAndApi({
      httpServer,
      hocuspocus: fakeHocuspocus,
      log: fakeLog as never,
      health: {
        readiness: () => {
          throw new Error('provider exploded');
        },
        degraded: () => [],
      },
    });
    const port = await getFreeLoopbackPort();
    await new Promise<void>((r) => httpServer.listen(port, '127.0.0.1', () => r()));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const body = (await res.json()) as { type: string };
      expect(body.type).toBe('urn:ok:error:internal-server-error');
    } finally {
      await mount.shutdown();
      await new Promise<void>((r) => mount.wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  });

  test('an omitted provider reports ready (synchronous-init harness posture)', async () => {
    const probe = await probeWithReadiness(undefined);
    expect(probe.status).toBe(200);
    expect(probe.body).toEqual({ ready: true, status: 'ready', degraded: [] });
  });
});
