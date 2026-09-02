import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-system-actions-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('system-actions group over the composed listener — served natively', () => {
  test('every path is registered natively with verb gating (405 + Allow: POST)', async () => {
    for (const path of ['/api/spawn-cursor', '/api/handoff', '/api/client-logs']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('POST');
    }
  });

  test('spawn-cursor reaches the real handler (its own 400 before any spawn)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/spawn-cursor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string; title?: string };
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toContain('path');
    expect(res.headers.get('x-request-id')).not.toBeNull();
  });

  test('handoff reaches the real handler (schema 400 before any dispatch)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('client-logs ingests a batch natively (accepted count, gap marker tolerated)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/client-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: [{ level: 'info', message: 'composition-pin entry' }],
        droppedSinceLastFlush: 1,
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted?: number }).accepted).toBe(1);
  });

  test('client-logs refuses a rebound Host before the verb check (403, no Allow leak)', async () => {
    const res = await rawRequest(server.port, '/api/client-logs', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.allow).toBeUndefined();
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });

  test('spawn-cursor and handoff are Host-gated by the shared read choke point', async () => {
    for (const path of ['/api/spawn-cursor', '/api/handoff']) {
      const res = await rawRequest(server.port, path, { headers: { Host: 'evil.example' } });
      expect(res.status, path).toBe(403);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/client-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ entries: [] }),
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
