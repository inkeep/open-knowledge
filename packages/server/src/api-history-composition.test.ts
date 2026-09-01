import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

const A_SHA = 'a'.repeat(40);

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-history-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('history group over the composed listener — served natively', () => {
  test('both the exact route and the dynamic prefix answer a wrong method with 405 + Allow: GET', async () => {
    for (const path of ['/api/history', `/api/history/${A_SHA}`]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('GET');
    }
  });

  test('the exact route serves a 200 timeline natively', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=alpha`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-request-id')).not.toBeNull();
  });

  test('the dynamic /api/history/:sha prefix reaches handleHistoryVersion natively', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history/${A_SHA}?docName=alpha`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:doc-not-found');
  });

  test('an empty sha (`/api/history/`) resolves to the :sha template with no dispatch (404)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history/`);
    expect(res.status).toBe(404);
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const history = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=alpha`);
    expect(history.status).toBe(200);
  });
});
