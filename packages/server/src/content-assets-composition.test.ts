import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';
import * as httpApp from './http/http-app.ts';

const shell = '<!doctype html><html><body>native shell marker</body></html>';
const binary = Buffer.from(Array.from({ length: 2_000_000 }, (_, i) => i % 256));
let root: string;
let server: BootedServer;
const legacyDispatch = vi.fn();
beforeEach(() => legacyDispatch.mockClear());

function wire(path: string, headers: Record<string, string> = {}) {
  return new Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    bytes: Buffer;
  }>((resolveResponse, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: server.port, path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolveResponse({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), 'ok-native-content-'));
  const content = resolve(root, 'content');
  const dist = resolve(root, 'dist');
  for (const base of [content, dist]) {
    for (const prefix of ['assets', 'excalidraw-assets', 'docs'])
      mkdirSync(resolve(base, prefix), { recursive: true });
  }
  writeFileSync(resolve(dist, 'index.html'), shell);
  writeFileSync(resolve(dist, 'docs', 'missing.html'), '<h1>shell HTML fallback</h1>');
  for (const prefix of ['assets', 'excalidraw-assets']) {
    writeFileSync(resolve(dist, prefix, 'collision.png'), `bundled ${prefix}`);
    writeFileSync(resolve(content, prefix, 'collision.png'), `content ${prefix}`);
    writeFileSync(resolve(content, prefix, 'only.png'), `content only ${prefix}`);
  }
  writeFileSync(resolve(dist, 'assets', 'app.js'), 'bundled javascript');
  writeFileSync(resolve(dist, 'assets', 'app.js.gz'), gzipSync('bundled javascript'));
  writeFileSync(resolve(dist, 'docs', 'collision.png'), 'shell collision');
  writeFileSync(resolve(content, 'docs', 'collision.png'), 'content collision');
  writeFileSync(resolve(content, 'docs', 'page.html'), '<h1>content HTML</h1>');
  writeFileSync(resolve(content, 'docs', 'large.png'), binary);
  writeFileSync(resolve(content, 'docs', 'ignored.txt'), 'ignored text readable by explicit API');
  writeFileSync(resolve(content, '.okignore'), 'docs/ignored.txt\n');
  const createHttpApp = httpApp.createHttpApp;
  const composition = vi.spyOn(httpApp, 'createHttpApp').mockImplementation((options) =>
    createHttpApp({
      ...options,
      legacyDispatch: (req, res) => {
        legacyDispatch(req.url);
        options.legacyDispatch(req, res);
      },
    }),
  );
  try {
    server = await bootCompositionRig(content, {
      reactShellDistDir: dist,
      serveContentAssets: true,
    });
  } finally {
    composition.mockRestore();
  }
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(root, { recursive: true, force: true });
});

describe('native serving over the real booted listener', () => {
  test('bundled prefixes win collisions while missing bundles fall through to content', async () => {
    const legacy = vi.spyOn(server.serverInstance.hocuspocus, 'hooks');
    try {
      for (const prefix of ['assets', 'excalidraw-assets']) {
        const bundled = await wire(`/${prefix}/collision.png`);
        expect(bundled.bytes.toString()).toBe(`bundled ${prefix}`);
        expect(bundled.headers['content-type']).toContain('image/png');
        expect(bundled.headers['content-disposition']).toBeUndefined();
        const content = await wire(`/${prefix}/only.png`);
        expect(content.bytes.toString()).toBe(`content only ${prefix}`);
        expect(content.headers['content-disposition']).toBe('inline');
      }
      const encodedPrefix = await wire('/%61ssets/collision.png');
      expect(encodedPrefix.bytes.toString()).toBe('content assets');
      expect(encodedPrefix.headers['content-disposition']).toBe('inline');
      const content = await wire('/docs/collision.png');
      expect(content.bytes.toString()).toBe('content collision');
      expect(content.headers['content-disposition']).toBe('inline');
      expect(legacy.mock.calls.filter(([name]) => name === 'onRequest')).toHaveLength(0);
      expect(legacyDispatch).not.toHaveBeenCalled();
    } finally {
      legacy.mockRestore();
    }
  });

  test('missing assets terminate while shell fallthrough preserves sirv extension rules', async () => {
    const legacy = vi.spyOn(server.serverInstance.hocuspocus, 'hooks');
    try {
      const missing = await wire('/docs/missing.png');
      expect(missing.status).toBe(404);
      expect(missing.bytes.length).toBe(0);
      for (const path of [
        '/docs/page',
        '/%ZZ',
        '/API/asset',
        '/api',
        '/mcp/',
        '/%61pi/asset',
        '/%6dcp',
      ]) {
        const response = await wire(path);
        expect(response.status, path).toBe(200);
        expect(response.bytes.toString(), path).toBe(shell);
        expect(response.headers['content-security-policy'], path).toBeUndefined();
        expect(response.headers['content-disposition'], path).toBeUndefined();
      }
      const html = await wire('/docs/missing.html');
      expect(html.bytes.toString()).toBe('<h1>shell HTML fallback</h1>');
      expect(html.headers['content-security-policy']).toBeUndefined();
      expect(html.headers['content-disposition']).toBeUndefined();
      expect(html.headers['x-content-type-options']).toBeUndefined();
      expect(html.headers['cache-control']).not.toBe('no-store');
      for (const path of ['/docs/missing.md', '/docs/ignored.txt', '/docs/absent.html']) {
        const missingFile = await wire(path);
        expect(missingFile.status, path).toBe(404);
        expect(missingFile.headers['content-type']).toBe('application/problem+json');
        expect(missingFile.headers['content-security-policy']).toBeUndefined();
        expect(missingFile.headers['content-disposition']).toBeUndefined();
      }
      expect(legacy.mock.calls.filter(([name]) => name === 'onRequest')).toHaveLength(0);
      expect(legacyDispatch).not.toHaveBeenCalled();
      const api = await rawRequest(server.port, '/api/not-a-route');
      expect(legacyDispatch).toHaveBeenCalledWith('/api/not-a-route');
      expect(parseProblem(api.body).title).toBe('API endpoint not found.');
      expect(legacy.mock.calls.some(([name]) => name === 'onRequest')).toBe(true);
    } finally {
      legacy.mockRestore();
    }
  });

  test('content HTML keeps its sandbox and shell routing does not reject Origin', async () => {
    const html = await wire('/docs/page.html', { Origin: 'https://untrusted.example' });
    expect(html.bytes.toString()).toBe('<h1>content HTML</h1>');
    expect(html.headers['content-security-policy']).toContain('sandbox');
    expect(html.headers['content-disposition']).toBe('inline');
    const response = await wire('/', { Origin: 'https://untrusted.example' });
    expect(response.bytes.toString()).toBe(shell);
    const shellHost = await wire('/', { Host: 'untrusted.example' });
    expect(shellHost.bytes.toString()).toBe(shell);
    const contentHost = await wire('/docs/page.html', { Host: 'untrusted.example' });
    expect(contentHost.status).toBe(403);
    expect(contentHost.bytes.toString()).toContain('Host header not allowed');
  });

  test('sirv retains HEAD, byte ranges, validators and precompressed bytes', async () => {
    const head = await rawRequest(server.port, '/assets/app.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength('bundled javascript')));
    const range = await wire('/docs/large.png', { Range: 'bytes=2-17' });
    expect(range.status).toBe(206);
    expect(range.bytes).toEqual(binary.subarray(2, 18));
    const asset = await wire('/assets/app.js');
    const etag = asset.headers.etag;
    expect(etag).toBeTypeOf('string');
    if (typeof etag !== 'string') throw new Error('Missing static validator');
    const unchanged = await wire('/assets/app.js', { 'If-None-Match': etag });
    expect(unchanged.status).toBe(304);
    expect(unchanged.bytes.length).toBe(0);
    const compressed = await wire('/assets/app.js', { 'Accept-Encoding': 'gzip' });
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(compressed.bytes).toString()).toBe('bundled javascript');
  });

  test('asset APIs preserve binary bytes, text ignore distinction, errors and method admission without legacy hooks', async () => {
    const legacy = vi.spyOn(server.serverInstance.hocuspocus, 'hooks');
    try {
      const asset = await wire('/api/asset?path=docs/large.png');
      expect(asset.bytes).toEqual(binary);
      expect(asset.headers['content-length']).toBe(String(binary.length));
      expect(asset.headers['cache-control']).toBe('no-store');
      expect(asset.headers['content-disposition']).toBe('inline');
      const ignored = await wire('/api/asset?path=docs/ignored.txt');
      expect(ignored.status).toBe(404);
      const text = await wire('/api/asset-text?path=docs/ignored.txt');
      expect(text.bytes.toString()).toBe('ignored text readable by explicit API');
      expect(text.headers['content-type']).toBe('text/plain; charset=utf-8');
      const cap = await wire('/api/asset-text?path=docs/large.png');
      expect(cap.status).toBe(413);
      for (const path of ['/api/asset', '/api/asset-text']) {
        const method = await rawRequest(server.port, path, { method: 'HEAD' });
        expect(method.status).toBe(405);
        expect(method.headers.allow).toBe('GET');
        const origin = await rawRequest(server.port, path, {
          headers: { Origin: 'https://untrusted.example' },
        });
        expect(origin.status).toBe(403);
        const preflight = await rawRequest(server.port, path, {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:5173' },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      }
      expect(legacy.mock.calls.filter(([name]) => name === 'onRequest')).toHaveLength(0);
      expect(legacyDispatch).not.toHaveBeenCalled();
    } finally {
      legacy.mockRestore();
    }
  });
});
