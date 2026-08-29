import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed folder-template group
 * (`folder-config` GET+PUT, `template` GET/PUT/POST/DELETE,
 * `template/import`) over a REAL socket through the composed `bootServer`
 * stack: verb gating, real handler responses, and the shared admission
 * posture. All three paths are legacy `MUTATING_ROUTES` members — that
 * DECLARATION is pinned at the table tier in
 * `http/folder-template-routes.test.ts`; the rebound-Host pins here hold
 * that the admission outcome is unchanged across the lift, GET arms
 * included.
 *
 * Every request below refuses (or reads) BEFORE any CRDT/session write —
 * the deep template write/move/import behavior keeps its coverage in the
 * dedicated integration suites, which now exercise the same native dispatch.
 */

/** Every path in the group, with the verbs the legacy record dispatched. */
const METHOD_SURFACE: ReadonlyArray<{ path: string; unsupported: string; allow: string }> = [
  { path: '/api/folder-config', unsupported: 'DELETE', allow: 'GET, PUT' },
  { path: '/api/template', unsupported: 'PATCH', allow: 'GET, PUT, POST, DELETE' },
  { path: '/api/template/import', unsupported: 'GET', allow: 'POST' },
];

const ALL_ROUTES = METHOD_SURFACE.map(({ path }) => path);

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-folder-template-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('folder-template group over the composed listener — served natively', () => {
  test('every path is registered natively with verb gating (405 + Allow)', async () => {
    for (const { path, unsupported, allow } of METHOD_SURFACE) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: unsupported });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe(allow);
    }
  });

  test('GET /api/folder-config serves the project root folder meta natively', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/folder-config?path=`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-request-id')).not.toBeNull();
    const body = (await res.json()) as { folder?: unknown };
    expect(body.folder).toBeDefined();
  });

  test('folder-config rejects an escaping path with its own 400 (dispatch reaches the handler)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/folder-config?path=${encodeURIComponent('../escape')}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('GET /api/template walks leaf → root and 404s an absent template', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template?name=absent&folder=`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:template-not-found');
  });

  test('template name validation survives the lift (bad name → 400)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/template?name=${encodeURIComponent('bad.name')}&folder=`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('template/import refuses a schema-invalid body with 400 before any doc read', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('all three paths refuse a rebound Host before the verb check (403, no Allow leak)', async () => {
    for (const path of ALL_ROUTES) {
      // DELETE/PATCH-class wrong verbs above prove 405 from loopback; here the
      // mutating gate must answer first even on a wrong-verb request.
      const res = await rawRequest(server.port, path, { headers: { Host: 'evil.example' } });
      expect(res.status, path).toBe(403);
      expect(res.headers.allow, path).toBeUndefined();
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/folder-config?path=`, {
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
