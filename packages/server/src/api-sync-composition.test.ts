import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

const MUTATING_ROUTES = [
  '/api/sync/trigger',
  '/api/sync/resolve-conflict',
  '/api/sync/resolve-blocking',
];

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-sync-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('sync group over the composed listener — served natively', () => {
  test('reads answer with their real engine-absent fallbacks (dormant status, empty conflicts)', async () => {
    const status = await fetch(`http://127.0.0.1:${server.port}/api/sync/status`);
    expect(status.status).toBe(200);
    expect(((await status.json()) as { state?: string }).state).toBe('dormant');
    const conflicts = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflicts`);
    expect(conflicts.status).toBe(200);
    expect(await conflicts.json()).toEqual({ conflicts: [] });
  });

  test('reads refuse the wrong verb with their own 405 (POST → 405 + Allow: GET)', async () => {
    for (const path of ['/api/sync/status', '/api/sync/conflicts', '/api/sync/conflict-content']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('GET');
    }
  });

  test('mutating trio is registered natively (GET → 405 + Allow: POST, x-request-id echoed)', async () => {
    for (const path of MUTATING_ROUTES) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('POST');
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('a mutating POST reaches the real handler (202 fire-and-return from the wired engine)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ op: 'sync' });
  });

  test('mutating trio refuses a rebound Host with 403 (loopback/host gate survives the lift)', async () => {
    for (const path of MUTATING_ROUTES) {
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
    const status = await fetch(`http://127.0.0.1:${server.port}/api/sync/status`);
    expect(status.status).toBe(200);
  });
});
