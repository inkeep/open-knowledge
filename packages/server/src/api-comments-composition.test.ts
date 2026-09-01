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
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-comments-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('comments group over the composed listener — served natively', () => {
  test('both routes are registered natively (PUT → 405 with the verb map, not a route-miss 404)', async () => {
    const comments = await fetch(`http://127.0.0.1:${server.port}/api/comments`, { method: 'PUT' });
    expect(comments.status).toBe(405);
    expect(comments.headers.get('allow')).toBe('GET, POST');
    const comment = await fetch(`http://127.0.0.1:${server.port}/api/comment`, { method: 'PUT' });
    expect(comment.status).toBe(405);
    expect(comment.headers.get('allow')).toBe('GET, POST, DELETE');
  });

  test('list reaches the real handler (project-wide 200 on an empty store)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/comments`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: [] });
  });

  test('missing-id read reaches the real handler (its own 400)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/comment`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
    expect(res.headers.get('x-request-id')).not.toBeNull();
  });

  test('a rebound Host is refused on every verb — the URL-keyed mutating gate covers the GET arms', async () => {
    for (const path of ['/api/comments', '/api/comment']) {
      const res = await rawRequest(server.port, path, {
        headers: { Host: 'evil.example' },
      });
      expect(res.status, path).toBe(403);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('chained groups still answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const comment = await fetch(`http://127.0.0.1:${server.port}/api/comment`);
    expect(comment.status).toBe(400);
  });
});
