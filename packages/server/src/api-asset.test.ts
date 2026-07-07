import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiExtension } from './api-extension.ts';
import type { ContentFilter } from './content-filter.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

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

function assetUrl(baseURL: string, path: string): string {
  return `${baseURL}/api/asset?path=${encodeURIComponent(path)}`;
}

describe('GET /api/asset', () => {
  let tmpDir: string;
  let contentDir: string;
  let harness: Harness;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-api-asset-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(join(contentDir, 'docs'), { recursive: true });
    writeFileSync(join(contentDir, 'docs', 'photo.png'), 'fake-png-bytes');
    writeFileSync(join(contentDir, 'docs', 'clip.mp4'), 'fake-mp4-bytes');
    writeFileSync(join(contentDir, 'docs', 'paper.pdf'), 'fake-pdf-bytes');
    writeFileSync(
      join(contentDir, 'docs', 'scripted.svg'),
      '<svg><script>alert("xss")</script></svg>',
    );
    writeFileSync(join(contentDir, 'docs', 'data.csv'), 'a,b\n1,2\n');
    writeFileSync(join(contentDir, 'docs', 'notes.txt'), 'not renderable');
    writeFileSync(
      join(contentDir, 'docs', 'page.html'),
      '<h1>trip viewer</h1><script>alert("x")</script>',
    );
    writeFileSync(join(contentDir, 'docs', 'legacy.htm'), '<h1>legacy</h1>');
    // `.js` has a known mrmime content type but is NOT in ASSET_EXTENSIONS —
    // exercises the admission gate independently of the content-type gate.
    writeFileSync(join(contentDir, 'docs', 'script.js'), 'alert(1)');
    mkdirSync(join(contentDir, 'docs', 'directory.png'));
    writeFileSync(join(tmpDir, 'outside.png'), 'outside');
    symlinkSync(join(tmpDir, 'outside.png'), join(contentDir, 'docs', 'escape.png'));
    harness = await startHarness(contentDir);
  });

  afterEach(async () => {
    await harness.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('serves supported assets inline with nosniff', async () => {
    const res = await fetch(assetUrl(harness.baseURL, 'docs/photo.png'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('fake-png-bytes');
  });

  test('serves non-image inline assets when they are renderable', async () => {
    const res = await fetch(assetUrl(harness.baseURL, 'docs/paper.pdf'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('fake-pdf-bytes');
  });

  test('serves SVG with a CSP sandbox for direct navigation', async () => {
    const res = await fetch(assetUrl(harness.baseURL, 'docs/scripted.svg'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('content-security-policy')).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(await res.text()).toBe('<svg><script>alert("xss")</script></svg>');
  });

  test('serves admitted non-renderable assets as attachments', async () => {
    const csvRes = await fetch(assetUrl(harness.baseURL, 'docs/data.csv'));
    const txtRes = await fetch(assetUrl(harness.baseURL, 'docs/notes.txt'));

    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('content-type')).toBe('text/csv');
    expect(csvRes.headers.get('content-disposition')).toBe('attachment');
    expect(await csvRes.text()).toBe('a,b\n1,2\n');
    expect(txtRes.status).toBe(200);
    expect(txtRes.headers.get('content-type')).toBe('text/plain');
    expect(txtRes.headers.get('content-disposition')).toBe('attachment');
    expect(await txtRes.text()).toBe('not renderable');
  });

  test('rejects missing and null-byte paths', async () => {
    expect((await fetch(`${harness.baseURL}/api/asset`)).status).toBe(400);
    expect((await fetch(`${harness.baseURL}/api/asset?path=docs/photo.png%00`)).status).toBe(400);
  });

  test('rejects unsupported extensions even when they have a known content type', async () => {
    // `.js` resolves to `text/javascript` via mrmime but is not in
    // ASSET_EXTENSIONS, so the admission gate 415s it.
    const res = await fetch(assetUrl(harness.baseURL, 'docs/script.js'));

    expect(res.status).toBe(415);
  });

  test.each([
    'docs/page.html',
    'docs/legacy.htm',
  ])('serves %s inside a sandboxed opaque origin (scripts run, network blocked, isolated from OK)', async (assetPath) => {
    // html/htm are admitted (so links resolve + serve) but render only under
    // the sandbox CSP: scripts run in a unique opaque origin and `connect-src
    // 'none'` blocks reaching OK's loopback API or exfiltrating.
    const res = await fetch(assetUrl(harness.baseURL, assetPath));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('content-security-policy')).toBe(
      "sandbox allow-scripts; connect-src 'none'",
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('rejects traversal and symlink escapes', async () => {
    expect((await fetch(assetUrl(harness.baseURL, '../outside.png'))).status).toBe(400);
    expect((await fetch(assetUrl(harness.baseURL, 'docs/escape.png'))).status).toBe(400);
  });

  test('rejects missing assets and non-file targets', async () => {
    expect((await fetch(assetUrl(harness.baseURL, 'docs/missing.png'))).status).toBe(404);
    expect((await fetch(assetUrl(harness.baseURL, 'docs/directory.png'))).status).toBe(404);
  });

  test('rejects unsupported methods', async () => {
    const res = await fetch(assetUrl(harness.baseURL, 'docs/photo.png'), { method: 'POST' });

    expect(res.status).toBe(405);
  });
});

describe('GET /api/asset content-filter exclusions', () => {
  let tmpDir: string;
  let contentDir: string;
  let harness: Harness;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-api-asset-cf-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(join(contentDir, 'docs'), { recursive: true });
    mkdirSync(join(contentDir, 'private'), { recursive: true });
    writeFileSync(join(contentDir, 'docs', 'allowed.png'), 'allowed-bytes');
    writeFileSync(join(contentDir, 'private', 'secret.png'), 'secret-bytes');

    const excludedDirSegment = 'private';
    const filter: ContentFilter = {
      isExcluded(rel: string): boolean {
        return rel === excludedDirSegment || rel.startsWith(`${excludedDirSegment}/`);
      },
      isDirExcluded(rel: string): boolean {
        return rel === excludedDirSegment || rel.startsWith(`${excludedDirSegment}/`);
      },
      isPathIgnored(rel: string): boolean {
        return rel === excludedDirSegment || rel.startsWith(`${excludedDirSegment}/`);
      },
      getWatcherIgnoreGlobs(): string[] {
        return [excludedDirSegment];
      },
      incrementMdDir(): void {},
      decrementMdDir(): void {},
      rebuildDirCount(): void {},
    };

    harness = await startHarness(contentDir, filter);
  });

  afterEach(async () => {
    await harness.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('serves assets that the filter admits', async () => {
    const res = await fetch(assetUrl(harness.baseURL, 'docs/allowed.png'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('allowed-bytes');
  });

  test('refuses assets excluded by .gitignore / .okignore as 404', async () => {
    const res = await fetch(assetUrl(harness.baseURL, 'private/secret.png'));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Asset not found');
  });
});
