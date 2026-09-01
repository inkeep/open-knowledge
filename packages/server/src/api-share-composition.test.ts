import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed share group over a REAL socket
 * through the composed `bootServer` stack — native registration and the
 * shared admission posture. Gate BEHAVIOR is owned by
 * `api-admission-composition.test.ts` (path-agnostic by construction); the
 * rebound-Host pins below re-pin gate REACHABILITY for this family — a
 * native-registration bug could mount the group outside
 * `createApiRequestPipeline` without changing any happy-path response, and a
 * hostile-header probe is the only wire signal that tells those apart. The
 * group's EMPTY mutating declaration (`share/publish` deliberately excluded)
 * is pinned at the table tier in `http/share-routes.test.ts`.
 *
 * Every request below refuses BEFORE any git subprocess or GitHub egress —
 * wrong verb, invalid identifiers, or the no-git-repo fallbacks — so the
 * suite never spawns the share CLI.
 */

const ALL_ROUTES = [
  '/api/share/construct-url',
  '/api/share/target-status',
  '/api/share/publish/owners',
  '/api/share/publish/name-check',
  '/api/share/publish',
];

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-share-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('share group over the composed listener — served natively', () => {
  test('every route in the group is registered natively (wrong verb → 405, not a route-miss 404)', async () => {
    for (const path of [
      '/api/share/construct-url',
      '/api/share/target-status',
      '/api/share/publish',
    ]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('POST');
    }
    for (const path of ['/api/share/publish/owners', '/api/share/publish/name-check']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('GET');
    }
  });

  test('construct-url reaches the real handler (no-git-repo → structured 200 no-remote)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/share/construct-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'doc', docPath: 'alpha.md' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: 'no-remote' });
  });

  test('name-check refuses malformed identifiers with its own 400 before any subprocess', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/share/publish/name-check?owner=-bad-&name=x`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
    expect(res.headers.get('x-request-id')).not.toBeNull();
  });

  test('publish refuses malformed identifiers with its own 400 before any subprocess', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/share/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: '-bad-', name: 'x', visibility: 'private' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('target-status refuses a malformed path with its own 400 before any git op', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/share/target-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'main', path: '../escape.md', kind: 'doc' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('a rebound Host is refused on every route (shared gate survives the lift)', async () => {
    for (const path of ALL_ROUTES) {
      const res = await rawRequest(server.port, path, {
        method: 'POST',
        headers: { Host: 'evil.example' },
      });
      expect(res.status, path).toBe(403);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('chained groups still answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const nameCheck = await fetch(
      `http://127.0.0.1:${server.port}/api/share/publish/name-check?owner=-bad-&name=x`,
    );
    expect(nameCheck.status).toBe(400);
  });
});
