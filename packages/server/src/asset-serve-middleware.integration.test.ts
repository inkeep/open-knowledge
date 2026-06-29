
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSET_EXTENSIONS,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import sirv from 'sirv';
import { createAssetServeMiddleware } from './asset-serve-middleware.ts';
import { createContentFilter } from './content-filter.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

interface Harness {
  baseURL: string;
  close: () => Promise<void>;
}

async function startHarness(contentDir: string): Promise<Harness> {
  const contentFilter = createContentFilter({
    projectDir: contentDir,
    contentDir,
  });
  const middleware = createAssetServeMiddleware({
    contentFilter,
    contentSirv: sirv(contentDir, { dev: true, dotfiles: false }),
    inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
    assetExtensions: ASSET_EXTENSIONS,
    blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
  });

  const server: Server = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end('<!-- spa fallback sentinel -->');
    });
  });

  const { baseUrl: baseURL } = await listenOnLoopback(server);

  return {
    baseURL,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('asset-serve middleware (narrow integration)', () => {
  let contentDir: string;
  let harness: Harness;

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-asset-serve-'));

    mkdirSync(join(contentDir, 'docs'));
    writeFileSync(join(contentDir, 'docs', 'guide.md'), '# Guide');

    writeFileSync(join(contentDir, 'docs', 'photo.png'), 'fake-png-bytes');
    writeFileSync(join(contentDir, 'docs', 'doc.pdf'), 'fake-pdf-bytes');
    writeFileSync(join(contentDir, 'docs', 'clip.m4v'), 'fake-m4v-bytes');
    writeFileSync(join(contentDir, 'docs', 'song.flac'), 'fake-flac-bytes');
    writeFileSync(
      join(contentDir, 'docs', 'diagram.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );

    writeFileSync(join(contentDir, 'docs', 'spec.docx'), 'fake-docx-bytes');
    writeFileSync(join(contentDir, 'docs', 'data.csv'), 'a,b\n1,2\n');
    writeFileSync(join(contentDir, 'docs', 'notes.txt'), 'some text');
    writeFileSync(join(contentDir, 'docs', 'archive.zip'), 'fake-zip-bytes');

    mkdirSync(join(contentDir, 'assets', 'images', 'characters'), { recursive: true });
    writeFileSync(join(contentDir, 'assets', 'images', 'characters', 'aang.png'), 'fake-png-bytes');

    harness = await startHarness(contentDir);
  });

  afterEach(async () => {
    await harness.close();
    rmSync(contentDir, { recursive: true, force: true });
  });

  describe('Content-Disposition dispatch for existing assets', () => {
    test('inline-renderable extensions get `Content-Disposition: inline`', async () => {
      for (const path of [
        '/docs/photo.png',
        '/docs/doc.pdf',
        '/docs/clip.m4v',
        '/docs/song.flac',
      ]) {
        const res = await fetch(`${harness.baseURL}${path}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toBe('inline');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      }
    });

    test('SVG serves inline AND with a CSP sandbox header (mirrors handleAsset)', async () => {
      const res = await fetch(`${harness.baseURL}/docs/diagram.svg`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('inline');
      expect(res.headers.get('content-security-policy')).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    test('non-inline admitted extensions get `Content-Disposition: attachment`', async () => {
      for (const path of [
        '/docs/spec.docx',
        '/docs/data.csv',
        '/docs/notes.txt',
        '/docs/archive.zip',
      ]) {
        const res = await fetch(`${harness.baseURL}${path}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toBe('attachment');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      }
    });

    test('markdown direct-URL request bypasses Content-Disposition', async () => {
      const res = await fetch(`${harness.baseURL}/docs/guide.md`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });

  describe('Content-Type correctness (sirv + mrmime map)', () => {
    test('PDF gets application/pdf', async () => {
      const res = await fetch(`${harness.baseURL}/docs/doc.pdf`);
      expect(res.headers.get('content-type')).toMatch(/^application\/pdf/);
    });

    test('PNG gets image/png', async () => {
      const res = await fetch(`${harness.baseURL}/docs/photo.png`);
      expect(res.headers.get('content-type')).toMatch(/^image\/png/);
    });

    test('CSV gets text/csv', async () => {
      const res = await fetch(`${harness.baseURL}/docs/data.csv`);
      expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    });

    test('M4V gets video/mp4 (mrmime gap closed in asset-serve-middleware)', async () => {
      const res = await fetch(`${harness.baseURL}/docs/clip.m4v`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^video\/mp4/);
    });

    test('MKV gets video/x-matroska', async () => {
      mkdirSync(join(contentDir, 'docs'), { recursive: true });
      writeFileSync(join(contentDir, 'docs', 'movie.mkv'), 'fake-mkv-bytes');
      const res = await fetch(`${harness.baseURL}/docs/movie.mkv`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^video\/x-matroska/);
    });

    test('FLAC gets audio/flac (RFC 9639)', async () => {
      const res = await fetch(`${harness.baseURL}/docs/song.flac`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^audio\/flac/);
    });

    test('TOML gets application/toml (mrmime gap closed for /api/asset)', async () => {
      writeFileSync(join(contentDir, 'docs', 'config.toml'), '# example\nkey = "value"\n');
      const res = await fetch(`${harness.baseURL}/docs/config.toml`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/toml/);
    });

    test('lockfile gets text/plain (mrmime gap closed for /api/asset)', async () => {
      writeFileSync(join(contentDir, 'docs', 'bun.lock'), '{}\n');
      const res = await fetch(`${harness.baseURL}/docs/bun.lock`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    });
  });

  describe('Fail-closed 404 guard', () => {
    test('missing asset path returns 404, NOT the SPA fallback sentinel', async () => {
      const res = await fetch(`${harness.baseURL}/docs/missing.m4v`);
      expect(res.status).toBe(404);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).not.toMatch(/^text\/html/);
      const body = await res.text();
      expect(body).not.toContain('spa fallback sentinel');
    });

    test('missing asset at root returns 404 (fail-closed for asset extensions, regardless of sibling-doc context)', async () => {
      const res = await fetch(`${harness.baseURL}/missing.m4v`);
      expect(res.status).toBe(404);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).not.toMatch(/^text\/html/);
      const body = await res.text();
      expect(body).not.toContain('spa fallback sentinel');
    });

    test('blocklisted-extension paths fall through to the SPA handler (never streamed)', async () => {
      const res = await fetch(`${harness.baseURL}/docs/malicious.dmg`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('spa fallback sentinel');
      expect(res.headers.get('content-disposition')).toBeNull();
    });

    test('missing unknown extension (not in asset or blocklist set) falls through to SPA fallback', async () => {
      const res = await fetch(`${harness.baseURL}/docs/anything.xyz`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('spa fallback sentinel');
    });
  });

  describe('Doc-referenced assets in dedicated asset directories', () => {
    test('asset in `assets/.../` with no sibling `.md` is served (the `![](../../assets/...)` pattern)', async () => {
      const res = await fetch(`${harness.baseURL}/assets/images/characters/aang.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('inline');
      expect(res.headers.get('content-type')).toMatch(/^image\/png/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const body = await res.text();
      expect(body).not.toContain('spa fallback sentinel');
    });

    test('a `.gitignore`/`.okignore`-excluded asset is still refused even in a dedicated assets dir', async () => {
      writeFileSync(join(contentDir, '.okignore'), 'assets/secret/\n');
      mkdirSync(join(contentDir, 'assets', 'secret'), { recursive: true });
      writeFileSync(join(contentDir, 'assets', 'secret', 'token.png'), 'sensitive-bytes');
      await harness.close();
      harness = await startHarness(contentDir);

      const res = await fetch(`${harness.baseURL}/assets/secret/token.png`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('spa fallback sentinel');
      expect(res.headers.get('content-disposition')).toBeNull();
    });
  });

  describe('Regression guards for the serve-side contract', () => {
    test('query strings are stripped from path resolution', async () => {
      const res = await fetch(`${harness.baseURL}/docs/doc.pdf?t=42`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('inline');
    });

    test('URL-encoded paths are decoded', async () => {
      mkdirSync(join(contentDir, 'docs', 'has space'));
      writeFileSync(join(contentDir, 'docs', 'has space', 'notes.md'), '# N');
      writeFileSync(join(contentDir, 'docs', 'has space', 'file.pdf'), 'fake');
      await harness.close();
      harness = await startHarness(contentDir);

      const res = await fetch(`${harness.baseURL}/docs/has%20space/file.pdf`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('inline');
    });

    test('nosniff header is set on every served response, regardless of disposition', async () => {
      const paths = ['/docs/photo.png', '/docs/data.csv', '/docs/guide.md'];
      for (const path of paths) {
        const res = await fetch(`${harness.baseURL}${path}`);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      }
    });
  });
});
