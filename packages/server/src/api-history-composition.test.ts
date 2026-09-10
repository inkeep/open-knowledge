import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

const A_SHA = 'a'.repeat(40);

let tmpRoot: string;
let contentDir: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-history-native-'));
  contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
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

  test('the folder arm (?folder=) serves a 200 timeline for a plain folder', async () => {
    mkdirSync(resolve(contentDir, 'plain-folder'), { recursive: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history?folder=plain-folder`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  test('the folder arm refuses a folder whose own .ok is a symlink (400 symlink-refused)', async () => {
    mkdirSync(resolve(contentDir, 'hist-target', 'templates'), { recursive: true });
    mkdirSync(resolve(contentDir, 'hist-aliased'), { recursive: true });
    symlinkSync('../hist-target', resolve(contentDir, 'hist-aliased', '.ok'), 'dir');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history?folder=hist-aliased`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:symlink-refused');
  });

  test('the folder arm answers 200 for a folder with a regular FILE named .ok (no templates gate here)', async () => {
    mkdirSync(resolve(contentDir, 'hist-flatok'), { recursive: true });
    writeFileSync(resolve(contentDir, 'hist-flatok', '.ok'), 'not a directory\n', 'utf-8');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history?folder=hist-flatok`);
    expect(res.status).toBe(200);
  });

  test.runIf(process.getuid?.() !== 0)(
    'the folder arm answers 200 for a folder whose .ok directory cannot be searched',
    async () => {
      const ownOk = resolve(contentDir, 'hist-unsearchable', '.ok');
      mkdirSync(ownOk, { recursive: true });
      chmodSync(ownOk, 0o000);
      try {
        const res = await fetch(
          `http://127.0.0.1:${server.port}/api/history?folder=hist-unsearchable`,
        );
        expect(res.status).toBe(200);
      } finally {
        chmodSync(ownOk, 0o755);
      }
    },
  );

  test('the folder arm answers 200 for an own .ok/templates link resolving outside the content root', async () => {
    const outside = resolve(tmpRoot, 'hist-outside-templates');
    mkdirSync(outside, { recursive: true });
    mkdirSync(resolve(contentDir, 'hist-esc', '.ok'), { recursive: true });
    symlinkSync(outside, resolve(contentDir, 'hist-esc', '.ok', 'templates'), 'dir');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history?folder=hist-esc`);
    expect(res.status).toBe(200);
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const history = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=alpha`);
    expect(history.status).toBe(200);
  });
});
