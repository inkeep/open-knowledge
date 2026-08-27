import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed skills.sh proxy group over a REAL
 * socket through the composed `bootServer` stack — native registration and
 * the shared admission posture. The wire cannot distinguish the mutating
 * gate from the read gate (both apply the same loopback + workspace-Host
 * checks), so the mutating DECLARATION itself is pinned at the table tier in
 * `http/skills-sh-routes.test.ts`; the rebound-Host pins here hold that the
 * admission outcome is unchanged across the lift.
 *
 * Every request below refuses BEFORE any outbound fetch (missing/invalid
 * params, wrong verb, or a gate) — the suite never reaches skills.sh, GitHub,
 * or `git clone`.
 */

/** The whole proxy family — method-gated, so a POST answers 405 when registered. */
const ALL_ROUTES = [
  '/api/skills/search',
  '/api/skills/popular',
  '/api/skills/publisher',
  '/api/skills/detail',
  '/api/skills/preview',
  '/api/skills/discover',
  '/api/skills/resolve-ref',
];

/** The clone-egress trio — legacy `MUTATING_ROUTES` members (declaration pinned in the table suite). */
const MUTATING_ROUTES = ['/api/skills/preview', '/api/skills/discover', '/api/skills/resolve-ref'];

/**
 * Missing-required-param requests that the real handler refuses with its OWN
 * 400 before any network egress — proving dispatch reaches the handler (an
 * unregistered path would return the pipeline's generic `/api/*` 404).
 */
const HANDLER_400S = [
  '/api/skills/search',
  '/api/skills/publisher',
  '/api/skills/detail',
  '/api/skills/preview',
  '/api/skills/discover',
  '/api/skills/resolve-ref',
];

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-skills-sh-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('skills.sh proxy group over the composed listener — served natively', () => {
  test('every route in the group is registered natively (POST → 405, not a route-miss 404)', async () => {
    for (const path of ALL_ROUTES) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(405);
    }
  });

  test('missing-param requests reach the real handler (its own 400, x-request-id echoed)', async () => {
    for (const path of HANDLER_400S) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { type?: string }).type, path).toBe(
        'urn:ok:error:invalid-request',
      );
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('mutating trio refuses a rebound Host with 403 (loopback/host gate survives the lift)', async () => {
    for (const path of MUTATING_ROUTES) {
      const res = await rawRequest(server.port, `${path}?source=owner/repo`, {
        headers: { Host: 'evil.example' },
      });
      expect(res.status, path).toBe(403);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('proxy reads are Host-gated by the shared read choke point too', async () => {
    const res = await rawRequest(server.port, '/api/skills/search?q=x', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const detail = await fetch(`http://127.0.0.1:${server.port}/api/skills/detail`);
    expect(detail.status).toBe(400);
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/skills/preview`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-origin');
  });

  test('OPTIONS preflight answers 204 on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/skills/search`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
  });

  test('any forwarding header trips the proxied-request refusal on a mutating route', async () => {
    const res = await rawRequest(server.port, '/api/skills/preview?source=owner/repo', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(res.status).toBe(403);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.detail ?? body.title).toContain('Proxied request refused');
  });
});
