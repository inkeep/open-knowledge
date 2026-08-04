import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import type { ContentFilter } from './content-filter.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

/**
 * Characterization for GET /api/asset-text ahead of the assets-service
 * extraction — this endpoint had no direct coverage. The pins mirror the
 * documented posture that deliberately DIFFERS from /api/asset: any
 * extension is admitted (no ASSET_EXTENSIONS gate) and ignored files are
 * served (no contentFilter gate) — path containment is the load-bearing
 * check, plus the 1 MiB viewer cap.
 */

interface Harness {
  baseURL: string;
  close: () => Promise<void>;
}

async function startHarness(contentDir: string, contentFilter?: ContentFilter): Promise<Harness> {
  const ext = createApiExtension({
    hocuspocus: {} as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    serverInstanceId: 'test-server',
    getFileIndex: () => new Map(),
    contentFilter,
  });

  const server: Server = createServer((req, res) => {
    void (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
  });

  const { baseUrl } = await listenOnLoopback(server);

  return {
    baseURL: baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function assetTextUrl(baseURL: string, path: string): string {
  return `${baseURL}/api/asset-text?path=${encodeURIComponent(path)}`;
}

describe('GET /api/asset-text', () => {
  let tmpDir: string;
  let contentDir: string;
  let harness: Harness;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-api-asset-text-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(join(contentDir, 'docs'), { recursive: true });
    writeFileSync(join(contentDir, 'docs', 'data.csv'), 'a,b\n1,2\n');
    writeFileSync(join(contentDir, 'docs', '.DS_Store'), 'dotfile-bytes');
    writeFileSync(join(contentDir, 'docs', 'photo.png'), 'fake-png-bytes');
    writeFileSync(join(contentDir, 'docs', 'huge.log'), 'x'.repeat(1_048_577));
    writeFileSync(join(contentDir, 'docs', 'ignored.txt'), 'hidden but readable');
    mkdirSync(join(contentDir, 'docs', 'somedir'));
    writeFileSync(join(tmpDir, 'outside.txt'), 'outside');
    symlinkSync(join(tmpDir, 'outside.txt'), join(contentDir, 'docs', 'escape.txt'));
    const filter = {
      isPathIgnored: (p: string) => p === 'docs/ignored.txt',
    } as unknown as ContentFilter;
    harness = await startHarness(contentDir, filter);
  });

  afterEach(async () => {
    await harness.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('serves any extension as forced text/plain with the viewer headers', async () => {
    const res = await fetch(assetTextUrl(harness.baseURL, 'docs/data.csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('a,b\n1,2\n');
  });

  test('no extension gate: dotfiles and binary-extension files are served as text', async () => {
    const dotfile = await fetch(assetTextUrl(harness.baseURL, 'docs/.DS_Store'));
    expect(dotfile.status).toBe(200);
    expect(await dotfile.text()).toBe('dotfile-bytes');

    const png = await fetch(assetTextUrl(harness.baseURL, 'docs/photo.png'));
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  test('no ignore-filter gate: an ignored file is still served (unlike /api/asset)', async () => {
    const res = await fetch(assetTextUrl(harness.baseURL, 'docs/ignored.txt'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hidden but readable');
  });

  test('missing path is a 400 invalid-request', async () => {
    const res = await fetch(`${harness.baseURL}/api/asset-text`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe('urn:ok:error:invalid-request');
  });

  test('nonexistent file is a 404 asset-not-found', async () => {
    const res = await fetch(assetTextUrl(harness.baseURL, 'docs/nope.txt'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe('urn:ok:error:asset-not-found');
  });

  test('a directory is a 404, not a listing', async () => {
    const res = await fetch(assetTextUrl(harness.baseURL, 'docs/somedir'));
    expect(res.status).toBe(404);
  });

  test('symlink escaping contentDir is a 400 invalid-request', async () => {
    const res = await fetch(assetTextUrl(harness.baseURL, 'docs/escape.txt'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe('urn:ok:error:invalid-request');
  });

  test('non-canonical traversal spelling is a 400 even when it stays inside', async () => {
    const res = await fetch(assetTextUrl(harness.baseURL, 'docs/../docs/data.csv'));
    expect(res.status).toBe(400);
  });

  test('files over the 1 MiB viewer cap are a 413', async () => {
    const res = await fetch(assetTextUrl(harness.baseURL, 'docs/huge.log'));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe('urn:ok:error:payload-too-large');
  });

  test('non-GET is a 405', async () => {
    const res = await fetch(assetTextUrl(harness.baseURL, 'docs/data.csv'), { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
