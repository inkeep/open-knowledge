import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed seed group (`seed/plan`, `seed/packs`
 * reads; `seed/apply`, `seed/install-pack-skill` mutating) over a REAL socket
 * through the composed `bootServer` stack: verb gating, real handler
 * responses, and the shared admission posture. The wire cannot distinguish
 * the mutating gate from the read gate (both apply the same loopback +
 * workspace-Host checks), so the mutating DECLARATION is pinned at the table
 * tier in `http/seed-routes.test.ts`; the rebound-Host pins here hold that
 * the admission outcome is unchanged across the lift.
 *
 * The rig seeds `<contentDir>/.ok/config.yml`, so `seed/plan` runs past its
 * prerequisite check and serves a real plan; no request below writes to disk
 * (`apply` refuses before `applySeed` on the malformed-plan pin).
 */

/** Every path in the group, with the verbs the legacy record dispatched. */
const METHOD_SURFACE: ReadonlyArray<{ path: string; unsupported: string; allow: string }> = [
  { path: '/api/seed/plan', unsupported: 'POST', allow: 'GET' },
  { path: '/api/seed/packs', unsupported: 'POST', allow: 'GET' },
  { path: '/api/seed/apply', unsupported: 'GET', allow: 'POST' },
  { path: '/api/seed/install-pack-skill', unsupported: 'GET', allow: 'POST' },
];

/** Legacy `MUTATING_ROUTES` members (declaration pinned in the table suite). */
const MUTATING_ROUTES = ['/api/seed/apply', '/api/seed/install-pack-skill'];

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-seed-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('seed group over the composed listener — served natively', () => {
  test('every path is registered natively with verb gating (405 + Allow)', async () => {
    for (const { path, unsupported, allow } of METHOD_SURFACE) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: unsupported });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe(allow);
    }
  });

  test('GET /api/seed/packs serves the starter-pack registry natively', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/seed/packs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-request-id')).not.toBeNull();
    const body = (await res.json()) as { packs?: unknown[] };
    expect(Array.isArray(body.packs)).toBe(true);
    expect(body.packs?.length).toBeGreaterThan(0);
  });

  test('GET /api/seed/plan serves a real plan (rig seeds the config.yml prerequisite)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/seed/plan`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan?: unknown };
    expect(body.plan).toBeDefined();
  });

  test('unknown packId reaches the real handlers (their own 400, not a route-miss 404)', async () => {
    const viaPlan = await fetch(
      `http://127.0.0.1:${server.port}/api/seed/plan?packId=not-a-real-pack`,
    );
    expect(viaPlan.status).toBe(400);
    expect(((await viaPlan.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');

    const viaInstall = await fetch(`http://127.0.0.1:${server.port}/api/seed/install-pack-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packId: 'not-a-real-pack' }),
    });
    expect(viaInstall.status).toBe(400);
    expect(((await viaInstall.json()) as { type?: string }).type).toBe(
      'urn:ok:error:invalid-request',
    );
  });

  test('POST /api/seed/apply refuses a malformed plan with its own 400 (no disk write)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/seed/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'not-an-object' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('mutating pair refuses a rebound Host before the verb check (403, no Allow leak)', async () => {
    for (const path of MUTATING_ROUTES) {
      // GET is the wrong verb for both — the mutating gate must answer first.
      const res = await rawRequest(server.port, path, { headers: { Host: 'evil.example' } });
      expect(res.status, path).toBe(403);
      expect(res.headers.allow, path).toBeUndefined();
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('read pair is Host-gated by the shared read choke point', async () => {
    for (const path of ['/api/seed/plan', '/api/seed/packs']) {
      const res = await rawRequest(server.port, path, { headers: { Host: 'evil.example' } });
      expect(res.status, path).toBe(403);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/seed/packs`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-origin');
  });

  test('sibling native groups still answer on the same server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const packs = await fetch(`http://127.0.0.1:${server.port}/api/seed/packs`);
    expect(packs.status).toBe(200);
  });
});
