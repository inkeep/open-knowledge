import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed workspace-tools group (`search`,
 * `link-preview`, `skill-targets`, `saved-themes`/`saved-theme`,
 * `generated-index/settings`) over a REAL socket through the composed
 * `bootServer` stack: verb gating (405 + `Allow` in declaration order — via
 * `methodRouter` for the four multi-verb paths, via `withValidation`'s
 * method check for single-verb `link-preview` and `saved-themes`), both
 * `/api/search` verbs served, and the shared admission posture. The wire
 * cannot distinguish the mutating gate from the read gate (both apply the
 * same loopback + workspace-Host checks), so the mutating DECLARATION is
 * pinned at the table tier in `http/workspace-tools-routes.test.ts`; the
 * rebound-Host pins here hold that the admission outcome is unchanged
 * across the lift, GET arms included.
 */

/** Every path in the group, with the verbs the legacy record dispatched. */
const METHOD_SURFACE: ReadonlyArray<{ path: string; unsupported: string; allow: string }> = [
  { path: '/api/search', unsupported: 'DELETE', allow: 'GET, POST' },
  { path: '/api/link-preview', unsupported: 'GET', allow: 'POST' },
  { path: '/api/skill-targets', unsupported: 'POST', allow: 'GET, PUT' },
  { path: '/api/saved-themes', unsupported: 'POST', allow: 'GET' },
  { path: '/api/saved-theme', unsupported: 'GET', allow: 'POST, PUT, DELETE' },
  { path: '/api/generated-index/settings', unsupported: 'DELETE', allow: 'GET, POST' },
];

/** Legacy `MUTATING_ROUTES` members (declaration pinned in the table suite). */
const MUTATING_ROUTES = ['/api/skill-targets', '/api/saved-theme', '/api/generated-index/settings'];

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-workspace-tools-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('workspace-tools group over the composed listener — served natively', () => {
  test('every path is registered natively with verb gating (405 + Allow)', async () => {
    for (const { path, unsupported, allow } of METHOD_SURFACE) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: unsupported });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe(allow);
    }
  });

  test('GET /api/search serves the search body natively (both verbs, one handler pair)', async () => {
    const viaGet = await fetch(`http://127.0.0.1:${server.port}/api/search?query=alpha`);
    expect(viaGet.status).toBe(200);
    expect(viaGet.headers.get('x-request-id')).not.toBeNull();
    const getBody = (await viaGet.json()) as { results?: unknown[] };
    expect(Array.isArray(getBody.results)).toBe(true);

    const viaPost = await fetch(`http://127.0.0.1:${server.port}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'alpha' }),
    });
    expect(viaPost.status).toBe(200);
    const postBody = (await viaPost.json()) as { results?: unknown[] };
    expect(Array.isArray(postBody.results)).toBe(true);
  });

  test('GET reads serve 200 natively (skill-targets, saved-themes, generated-index settings)', async () => {
    for (const path of [
      '/api/skill-targets',
      '/api/saved-themes',
      '/api/generated-index/settings',
    ]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('application/json');
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('link-preview anti-proxy gate survives the lift (no Origin → 403 before any fetch)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/link-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-origin');
  });

  test('link-preview serves the coarse blocked envelope through the lift (no egress attempted)', async () => {
    // A literal loopback target lets the pin run without real network egress;
    // the wire cannot tell a pre-I/O guard refusal from a failed connect
    // (both collapse to the ONE coarse category by design), so the SSRF
    // guard itself is pinned at the unit tier in
    // `link-preview/guarded-fetch.test.ts` — this pin holds the collapsed
    // wire shape across the lift.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/link-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: JSON.stringify({ url: 'http://127.0.0.1/' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'blocked' });
  });

  test('legacy-mutating paths refuse a rebound Host on their GET arms too (admission unchanged)', async () => {
    for (const path of MUTATING_ROUTES) {
      const res = await rawRequest(server.port, path, {
        headers: { Host: 'evil.example' },
      });
      expect(res.status, path).toBe(403);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('read paths are Host-gated by the shared read choke point', async () => {
    const res = await rawRequest(server.port, '/api/saved-themes', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const search = await fetch(`http://127.0.0.1:${server.port}/api/search?query=alpha`);
    expect(search.status).toBe(200);
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/search?query=alpha`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-origin');
  });

  test('allowed browser Origin gets CORS reflection on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/search?query=alpha`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  test('OPTIONS preflight answers 204 on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/skill-targets`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
  });

  test('any forwarding header trips the proxied-request refusal on a ported route', async () => {
    const res = await rawRequest(server.port, '/api/skill-targets', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(res.status).toBe(403);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.detail ?? body.title).toContain('Proxied request refused');
  });
});
