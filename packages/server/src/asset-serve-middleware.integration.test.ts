/**
 * Narrow-integration tests for the asset-serve middleware.
 *
 * Builds a minimal HTTP stack against a real `createContentFilter` + real
 * `sirv` + a real `http.createServer` on an ephemeral port, then asserts
 * full HTTP response shape (status, Content-Type, Content-Disposition,
 * body) via `fetch`.
 *
 * Why narrow-integration rather than unit-only: `sirv` + `mrmime`
 * determine the Content-Type header (empty string for unknown extensions
 * like `.m4v` — that's a real contract we want to pin). The unit tests
 * stub sirv and can't see that behavior. A sirv/mrmime upgrade that
 * shifts the mime map is a silent contract break; this tier catches it.
 *
 * Determinism: all files are seeded on disk BEFORE `createContentFilter`
 * is constructed so the synchronous `populateDirCount` walk at
 * `content-filter.ts` picks them up at startup. No file watcher,
 * no async dirCount updates. Same pattern as
 * `packages/server/src/content-filter.test.ts`.
 *
 * Precedents: `packages/cli/src/commands/ui.test.ts` (real HTTP + sirv
 * + Content-Disposition assertions), `packages/server/src/api-extension.test.ts`
 * (real HTTP + listen-on-0 + fetch).
 */

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

/**
 * Spin up a real HTTP server with the asset-serve middleware over a
 * tmpdir. Files must be seeded BEFORE calling this — the content filter
 * captures dirCount at construct time.
 */
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
      // No further middleware in this harness. Fall-through path —
      // simulating what Vite's htmlFallbackMiddleware would do in
      // production — returns 200 text/html with a sentinel body so we
      // can distinguish "fell through" from "sirv served" vs "404 guard
      // fired" in assertions.
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

    // Seed a subdirectory doc + representative assets. Populated BEFORE
    // filter construction so dirCount['docs'] starts at 1.
    mkdirSync(join(contentDir, 'docs'));
    writeFileSync(join(contentDir, 'docs', 'guide.md'), '# Guide');

    // Inline-renderable (each class)
    writeFileSync(join(contentDir, 'docs', 'photo.png'), 'fake-png-bytes');
    writeFileSync(join(contentDir, 'docs', 'doc.pdf'), 'fake-pdf-bytes');
    writeFileSync(join(contentDir, 'docs', 'clip.m4v'), 'fake-m4v-bytes');
    writeFileSync(join(contentDir, 'docs', 'song.flac'), 'fake-flac-bytes');
    // SVG with an embedded <script> — `.svg` is in INLINE_RENDERABLE_EXTENSIONS,
    // so it serves with `inline` disposition; the CSP sandbox must accompany it.
    writeFileSync(
      join(contentDir, 'docs', 'diagram.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );

    // Admitted non-inline (office + tabular + archive)
    writeFileSync(join(contentDir, 'docs', 'spec.docx'), 'fake-docx-bytes');
    writeFileSync(join(contentDir, 'docs', 'data.csv'), 'a,b\n1,2\n');
    writeFileSync(join(contentDir, 'docs', 'notes.txt'), 'some text');
    writeFileSync(join(contentDir, 'docs', 'archive.zip'), 'fake-zip-bytes');

    // Asset in a dedicated `assets/` tree with NO sibling `.md` anywhere —
    // the standard organization for doc-referenced media (`![](../../assets/images/x.png)`).
    // `dirCount['assets/images/characters']` is 0 at filter-construct time.
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
      // Each representative class: image, PDF, video, audio
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
      // `.svg` is in INLINE_RENDERABLE_EXTENSIONS, so it gets `inline` — but a
      // top-level GET of an SVG executes embedded <script> (`image/svg+xml` is
      // CORB-excluded; `nosniff` doesn't help). The CSP sandbox neutralizes it,
      // matching `handleAsset` (api-extension.ts). The editor's `<img src>`
      // render path is unaffected (embeds don't run SVG scripts).
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
      // .md is neither inline nor non-inline for this policy — the editor
      // fetches via /api/document. Direct URL should stream raw markdown
      // with NO Content-Disposition (no forced download).
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
      // `.m4v` is NOT in mrmime's default mime table; we register it as
      // `video/mp4` at module load in `asset-serve-middleware.ts`. Before
      // that patch, sirv emitted empty Content-Type → Chromium rendered
      // the binary bytes as garbled text (user-visible regression).
      //
      // Post-patch: Chromium's built-in video viewer plays the file
      // inline in the new tab. Safe under nosniff — video/* is never
      // treated as scriptable regardless of file contents.
      //
      // Pinning explicit video/mp4 here catches (a) accidental removal
      // of the patch, (b) mrmime adopting a different upstream mapping
      // in a future version.
      const res = await fetch(`${harness.baseURL}/docs/clip.m4v`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^video\/mp4/);
    });

    test('MKV gets video/x-matroska', async () => {
      // Similarly covered by the mrmime patch. De-facto mime type; no
      // IANA-registered alternative exists.
      mkdirSync(join(contentDir, 'docs'), { recursive: true });
      writeFileSync(join(contentDir, 'docs', 'movie.mkv'), 'fake-mkv-bytes');
      // Harness filter captured dirCount at construct time; `docs/` is
      // already admitted. New file in an admitted dir is served.
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
      // TOML has an IANA-registered media type but `mrmime` doesn't
      // ship it by default — same patch class as the `.m4v` and
      // `.flac` entries. Without this, `sirv` serves `.toml`
      // with an empty `Content-Type` and the `/api/asset` handler's
      // `assetContentTypeForPath` lookup returns null → 415. The
      // `TextViewer` path (`/api/asset-text`) forces `text/plain` and
      // is unaffected. Pin the registration so a future mrmime upgrade
      // or accidental removal trips the gate.
      writeFileSync(join(contentDir, 'docs', 'config.toml'), '# example\nkey = "value"\n');
      const res = await fetch(`${harness.baseURL}/docs/config.toml`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/toml/);
    });

    test('lockfile gets text/plain (mrmime gap closed for /api/asset)', async () => {
      // `.lock` has no IANA media type and no mrmime default — same
      // patch class as `.toml`. Without this, the
      // `INLINE_RENDERABLE_EXTENSIONS` widening that lets `.lock`
      // dispatch to the sidebar's `TextViewer` would 415 on direct
      // `/api/asset?path=foo.lock` deeplinks. The sidebar-click
      // surface uses `/api/asset-text` (forces `text/plain`) and is
      // unaffected — what this test pins is the symmetry between the
      // two read paths so a future mrmime upgrade can't silently
      // re-open the 415.
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
      // Must NOT be the fall-through path that returns text/html.
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).not.toMatch(/^text\/html/);
      const body = await res.text();
      expect(body).not.toContain('spa fallback sentinel');
    });

    test('missing asset at root returns 404 (fail-closed for asset extensions, regardless of sibling-doc context)', async () => {
      // The serve path uses `isPathIgnored`, not `isExcluded` — so a missing
      // asset-extension URL hits the fail-closed 404 guard rather than the SPA
      // fallback, whether or not its directory holds a sibling `.md`. (Previously
      // root paths leaked the editor HTML for missing `.m4v` URLs — the very
      // anti-pattern the 404 guard exists to prevent.)
      const res = await fetch(`${harness.baseURL}/missing.m4v`);
      expect(res.status).toBe(404);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).not.toMatch(/^text\/html/);
      const body = await res.text();
      expect(body).not.toContain('spa fallback sentinel');
    });

    test('blocklisted-extension paths fall through to the SPA handler (never streamed)', async () => {
      // `.dmg` is in EXECUTABLE_BLOCKLIST_EXTENSIONS and NOT in ASSET_EXTENSIONS,
      // so the middleware's "servable content extension" gate fires before sirv —
      // it delegates to next(), which in production hits Vite's SPA fallback
      // (here: the sentinel). The contentDir file never streams back. The
      // blocklist itself remains the security control for the Electron
      // `openAssetSafely` *click* path; this is the serve-side mirror.
      const res = await fetch(`${harness.baseURL}/docs/malicious.dmg`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('spa fallback sentinel');
      expect(res.headers.get('content-disposition')).toBeNull();
    });

    test('missing unknown extension (not in asset or blocklist set) falls through to SPA fallback', async () => {
      // `.xyz` is neither `.md`/`.mdx` nor a known asset extension — the
      // servable-extension gate bails to next() before sirv ever runs (same as
      // the unit-tier test). In production this is Vite's SPA fallback (here:
      // the sentinel).
      const res = await fetch(`${harness.baseURL}/docs/anything.xyz`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('spa fallback sentinel');
    });
  });

  describe('Doc-referenced assets in dedicated asset directories', () => {
    test('asset in `assets/.../` with no sibling `.md` is served (the `![](../../assets/...)` pattern)', async () => {
      // Regression for the Electron-app image 404: a doc such as
      // `characters/air-nomads/aang.md` referencing `../../assets/images/characters/aang.png`
      // normalizes to a server-absolute `/assets/images/characters/aang.png`, but the
      // serve middleware was gating on `contentFilter.isExcluded`, which applies the
      // sibling-asset heuristic — an asset is admitted only if its directory holds
      // an included `.md`. A dedicated `assets/` tree has none, so the image 404'd.
      // The serve path must use `isPathIgnored` (security boundary only).
      const res = await fetch(`${harness.baseURL}/assets/images/characters/aang.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('inline');
      expect(res.headers.get('content-type')).toMatch(/^image\/png/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const body = await res.text();
      expect(body).not.toContain('spa fallback sentinel');
    });

    test('a `.gitignore`/`.okignore`-excluded asset is still refused even in a dedicated assets dir', async () => {
      // The security boundary survives: `isPathIgnored` honors user-configured
      // ignore rules. Seed an `.okignore` excluding `assets/secret/` and re-build
      // the harness so the new ignore file is picked up.
      writeFileSync(join(contentDir, '.okignore'), 'assets/secret/\n');
      mkdirSync(join(contentDir, 'assets', 'secret'), { recursive: true });
      writeFileSync(join(contentDir, 'assets', 'secret', 'token.png'), 'sensitive-bytes');
      await harness.close();
      harness = await startHarness(contentDir);

      const res = await fetch(`${harness.baseURL}/assets/secret/token.png`);
      // Middleware bails to next() before touching sirv → SPA fallback in this harness.
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('spa fallback sentinel');
      // It never set the asset-serve headers.
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
      // Need a fresh harness — filter dirCount for `docs/has space` was 0
      // when the original harness started. Re-seed + re-start.
      await harness.close();
      harness = await startHarness(contentDir);

      const res = await fetch(`${harness.baseURL}/docs/has%20space/file.pdf`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('inline');
    });

    test('nosniff header is set on every served response, regardless of disposition', async () => {
      // Inline, attachment, and .md bypass all set nosniff. Only excluded
      // paths (which fall through to next() immediately without setting
      // headers) skip it — and that's correct, since next() is supposed
      // to serve a different response entirely.
      const paths = ['/docs/photo.png', '/docs/data.csv', '/docs/guide.md'];
      for (const path of paths) {
        const res = await fetch(`${harness.baseURL}${path}`);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      }
    });
  });
});
