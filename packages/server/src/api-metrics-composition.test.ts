import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed metrics read group over a REAL socket
 * through the composed `bootServer` stack — the SECOND native group, so a 200
 * here also proves the multi-group `nativeApi` composition (concatenated
 * paths, chained per-group pipeline dispatches): the link/graph group's table
 * declines these URLs and the chain falls through to the metrics pipeline.
 * Mirrors `api-link-graph-composition.test.ts` for the group-1 pins.
 *
 * The three gated diagnostics (agent-presence, agent-effects, watcher-recent)
 * enforce loopback + Host INLINE, before method dispatch — the pins below
 * hold the gate-before-405 ordering (a bad Host must never learn the verb).
 */

let tmpRoot: string;
let server: BootedServer;
let ephemeral: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-metrics-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;

  const ephemeralDir = mkdtempSync(resolve(tmpRoot, 'ephemeral-'));
  writeFileSync(resolve(ephemeralDir, 'note.md'), '# note\n', 'utf-8');
  ephemeral = await bootCompositionRig(ephemeralDir, {
    ephemeral: true,
    singleDocRelPath: 'note.md',
  });
  await ephemeral.ready;
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([server?.destroy(), ephemeral?.destroy()]);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('metrics group over the composed listener — served natively', () => {
  test('every route in the group answers (absent from the legacy registry)', async () => {
    for (const path of [
      '/api/metrics/reconciliation',
      '/api/metrics/parse-health',
      '/api/metrics/agent-presence',
      '/api/metrics/agent-effects',
      '/api/metrics/watcher-recent',
    ]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('application/json');
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    // Group 1 (link/graph) resolves first in the chain; group 2 (metrics)
    // only answers after group 1 declines. One server, both arms live.
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const metrics = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`);
    expect(metrics.status).toBe(200);
  });

  test('method gate holds on an ungated route (POST answers 405 + Allow: GET)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  test('gated diagnostics refuse a rebound Host with 403 (inline gate survives the lift)', async () => {
    for (const path of [
      '/api/metrics/agent-presence',
      '/api/metrics/agent-effects',
      '/api/metrics/watcher-recent',
    ]) {
      const res = await rawRequest(server.port, path, {
        headers: { Host: 'evil.example' },
      });
      expect(res.status, path).toBe(403);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('gate-before-405: a bad Host on a wrong verb gets 403, never the verb hint', async () => {
    const res = await rawRequest(server.port, '/api/metrics/agent-presence', {
      method: 'POST',
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.allow).toBeUndefined();
  });

  test('gated diagnostics answer the method gate once the Host passes (POST → 405 + Allow: GET)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/agent-presence`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-origin');
  });

  test('allowed browser Origin gets CORS reflection on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  test('OPTIONS preflight answers 204 on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
  });

  test('any forwarding header trips the proxied-request refusal on a ported route', async () => {
    const res = await rawRequest(server.port, '/api/metrics/reconciliation', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(res.status).toBe(403);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.detail ?? body.title).toContain('Proxied request refused');
  });

  test('read posture parity: a read WITHOUT an inline gate is refused under a rebound Host', async () => {
    // Flipped pin (read-posture hardening): the pipeline Host-gates every
    // /api read in normal mode too, so routes without an inline gate are
    // covered by the shared choke point.
    const res = await rawRequest(server.port, '/api/metrics/reconciliation', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });

  test('ephemeral mode Host-gates the ported reads too', async () => {
    const res = await rawRequest(ephemeral.port, '/api/metrics/reconciliation', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });
});
