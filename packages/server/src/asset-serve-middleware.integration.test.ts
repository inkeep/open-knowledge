import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSET_EXTENSIONS,
  createTargetNamespace,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import sirv from 'sirv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createAssetServeMiddleware } from './asset-serve-middleware.ts';
import { createContentFilter } from './content-filter.ts';
import { closeTestHttpServer } from './http-server.test-helper.ts';
import { buildIngressPolicy } from './ingress-policy.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

interface Harness {
  baseURL: string;
  close: () => Promise<void>;
}

async function startHarness(
  contentDir: string,
  resolveTrackedFile?: (relativePath: string) => string | undefined,
): Promise<Harness> {
  const contentFilter = createContentFilter({
    projectDir: contentDir,
    contentDir,
  });
  const middleware = createAssetServeMiddleware({
    contentDir,
    contentFilter,
    contentSirv: sirv(contentDir, { dev: true, dotfiles: false }),
    inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
    assetExtensions: ASSET_EXTENSIONS,
    blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
    ingressPolicy: buildIngressPolicy({}),
    resolveTrackedFile,
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
    close: () => closeTestHttpServer(server),
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

  describe('Symlinked content stays inside the repository', () => {
    const SECRET = 'machine-local-secret';

    beforeEach(() => {
      mkdirSync(join(contentDir, '.ok', 'local'), { recursive: true });
      writeFileSync(join(contentDir, '.ok', 'local', 'principal.json'), `{"token":"${SECRET}"}`);
      mkdirSync(join(contentDir, '.git'), { recursive: true });
      writeFileSync(join(contentDir, '.git', 'config'), `[core]\n\t# ${SECRET}\n`);
    });

    test('a markdown link into machine-local state is not served', async () => {
      symlinkSync('../.ok/local/principal.json', join(contentDir, 'docs', 'leak.md'));
      const res = await fetch(`${harness.baseURL}/docs/leak.md`);
      const body = await res.text();
      expect(body).not.toContain(SECRET);
      expect(body).toContain('spa fallback sentinel');
    });

    test('an asset link to the git config is not served', async () => {
      symlinkSync('../.git/config', join(contentDir, 'docs', 'cfg.txt'));
      const res = await fetch(`${harness.baseURL}/docs/cfg.txt`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(SECRET);
    });

    test('an asset link outside the content dir is not served', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'ok-asset-serve-outside-'));
      try {
        writeFileSync(join(outsideDir, 'secret.png'), SECRET);
        symlinkSync(join(outsideDir, 'secret.png'), join(contentDir, 'docs', 'outside.png'));
        const res = await fetch(`${harness.baseURL}/docs/outside.png`);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain(SECRET);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    test('a path is checked as sirv decodes it, not as the extension gate decodes it', async () => {
      writeFileSync(join(contentDir, 'docs', 'x+.png'), 'harmless-bytes');
      symlinkSync('../.ok/local/principal.json', join(contentDir, 'docs', 'x%2B.png'));
      const res = await fetch(`${harness.baseURL}/docs/x%2B.png`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(SECRET);
    });

    test('a missing asset does not fall back to a linked html sibling', async () => {
      symlinkSync('../.ok/local/principal.json', join(contentDir, 'docs', 'gone.png.html'));
      const res = await fetch(`${harness.baseURL}/docs/gone.png`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(SECRET);
    });

    test('an in-root link to an ordinary asset is still served', async () => {
      symlinkSync('photo.png', join(contentDir, 'docs', 'alias.png'));
      const res = await fetch(`${harness.baseURL}/docs/alias.png`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('fake-png-bytes');
    });
  });

  describe('Content-serve ingress gate (DNS-rebinding defense)', () => {
    function getWithHost(path: string, host: string): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const url = new URL(path, harness.baseURL);
        const req = httpRequest(
          { host: url.hostname, port: url.port, path: url.pathname, headers: { Host: host } },
          (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    }

    test('a rebound Host on an existing asset is refused BEFORE the disk read', async () => {
      const res = await getWithHost('/docs/photo.png', 'evil.example.com');
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as { type?: string }).type).toBe(
        'urn:ok:error:host-not-allowed',
      );
    });

    test('a rebound Host on a markdown doc path is refused the same way', async () => {
      const res = await getWithHost('/docs/guide.md', 'evil.example.com');
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as { type?: string }).type).toBe(
        'urn:ok:error:host-not-allowed',
      );
    });

    test('a rebound Host on a NON-content path still falls through (SPA shell stays ungated)', async () => {
      const res = await getWithHost('/some/deep-link', 'evil.example.com');
      expect(res.status).toBe(200);
      expect(res.body).toContain('spa fallback sentinel');
    });

    test('a loopback Host keeps serving the asset (legit traffic unaffected)', async () => {
      const url = new URL('/docs/photo.png', harness.baseURL);
      const res = await getWithHost('/docs/photo.png', `127.0.0.1:${url.port}`);
      expect(res.status).toBe(200);
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

  describe('Raw request targets that only an HTTP client can send', () => {
    const SECRET = 'ignored-secret-bytes';

    function rawGet(target: string): Promise<{ statusLine: string; response: string }> {
      const { hostname, port } = new URL(harness.baseURL);
      return new Promise((resolve, reject) => {
        let response = '';
        const socket = connect({ host: hostname, port: Number(port) }, () => {
          socket.write(
            `GET ${target} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`,
          );
        });
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          response += chunk;
        });
        socket.on('end', () => resolve({ statusLine: response.split('\r\n')[0] ?? '', response }));
        socket.on('error', reject);
      });
    }

    test('a # in the request line never serves the ignored file its prefix names', async () => {
      writeFileSync(join(contentDir, '.okignore'), '/docs/secret\n');
      writeFileSync(join(contentDir, 'docs', 'secret'), SECRET);
      writeFileSync(join(contentDir, '.env'), SECRET);
      await harness.close();
      harness = await startHarness(contentDir);

      const answers: Array<[string, string, boolean]> = [];
      for (const target of ['/docs/secret#.png', '/.env#.png']) {
        const { statusLine, response } = await rawGet(target);
        answers.push([target, statusLine, response.includes(SECRET)]);
      }
      expect(answers).toEqual([
        ['/docs/secret#.png', 'HTTP/1.1 404 Not Found', false],
        ['/.env#.png', 'HTTP/1.1 404 Not Found', false],
      ]);
    });

    test('an encoded reserved character the gate and sirv decode differently is refused before sirv', async () => {
      writeFileSync(join(contentDir, '.okignore'), 'x%2Fy.png\n');
      writeFileSync(join(contentDir, 'docs', 'x%2Fy.png'), SECRET);
      await harness.close();
      harness = await startHarness(contentDir);

      const { statusLine, response } = await rawGet('/docs/x%2Fy.png');
      expect(statusLine).toBe('HTTP/1.1 404 Not Found');
      expect(response).not.toContain(SECRET);
    });

    test('dot, empty and backslash segments never route around an anchored ignore rule', async () => {
      function bodyOf(response: string): string {
        if (response.includes(SECRET)) return 'secret';
        if (response.includes('spa fallback sentinel')) return 'spa fallback';
        return 'neither';
      }
      writeFileSync(join(contentDir, 'docs', 'secret.png'), SECRET);
      const beforeTheRule = await rawGet('/docs/secret.png');
      writeFileSync(join(contentDir, '.okignore'), '/docs/secret.png\n');
      const backslashSpelling = 'x\\..\\docs\\secret.png';
      writeFileSync(join(contentDir, backslashSpelling), SECRET);
      await harness.close();
      harness = await startHarness(contentDir);

      const answers: Array<[string, string, string]> = [];
      for (const target of [
        '/docs/secret.png',
        '/docs/./secret.png',
        '/docs//secret.png',
        '/x/../docs/secret.png',
        `/${encodeURIComponent(backslashSpelling)}`,
      ]) {
        const { statusLine, response } = await rawGet(target);
        answers.push([target, statusLine, bodyOf(response)]);
      }
      expect([beforeTheRule.statusLine, bodyOf(beforeTheRule.response)]).toEqual([
        'HTTP/1.1 200 OK',
        'secret',
      ]);
      expect(answers).toEqual([
        ['/docs/secret.png', 'HTTP/1.1 200 OK', 'spa fallback'],
        ['/docs/./secret.png', 'HTTP/1.1 404 Not Found', 'neither'],
        ['/docs//secret.png', 'HTTP/1.1 404 Not Found', 'neither'],
        ['/x/../docs/secret.png', 'HTTP/1.1 404 Not Found', 'neither'],
        ['/x%5C..%5Cdocs%5Csecret.png', 'HTTP/1.1 404 Not Found', 'neither'],
      ]);
    });

    test('a request line both decoders agree on is still served', async () => {
      const { statusLine, response } = await rawGet('/docs/photo.png?v=1');
      expect(statusLine).toBe('HTTP/1.1 200 OK');
      expect(response).toContain('fake-png-bytes');
    });
  });

  describe('Tracked-file fallback when the requested spelling misses on disk', () => {
    const CAFE_NFD = 'docs/Café.png'.normalize('NFD');
    const SECRET = 'machine-local-secret';

    async function restartWithTracked(trackedFiles: readonly string[]): Promise<void> {
      await harness.close();
      const tracked = createTargetNamespace('file', trackedFiles);
      harness = await startHarness(contentDir, (relativePath) => tracked.resolve(relativePath));
    }

    test('an NFC request serves the NFD-named file on every platform', async () => {
      writeFileSync(join(contentDir, CAFE_NFD), 'nfd-bytes');
      await restartWithTracked([CAFE_NFD]);
      const nfc = encodeURI('/docs/Café.png'.normalize('NFC'));
      const res = await fetch(`${harness.baseURL}${nfc}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^image\/png/);
      expect(res.headers.get('content-disposition')).toBe('inline');
      expect(await res.text()).toBe('nfd-bytes');
    });

    test('a leaf-case request serves the tracked file on every platform', async () => {
      await restartWithTracked(['docs/photo.png']);
      const res = await fetch(`${harness.baseURL}/docs/PHOTO.PNG`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('fake-png-bytes');
    });

    test('a tracked symlink into private state is still refused', async () => {
      mkdirSync(join(contentDir, '.git'), { recursive: true });
      writeFileSync(join(contentDir, '.git', 'config'), `[core]\n\t# ${SECRET}\n`);
      symlinkSync('../.git/config', join(contentDir, 'docs', 'cfg.txt'));
      await restartWithTracked(['docs/cfg.txt']);
      const res = await fetch(`${harness.baseURL}/docs/CFG.TXT`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(SECRET);
    });

    test('a tracked name holding ? never serves the ignored file its prefix names', async () => {
      writeFileSync(join(contentDir, '.okignore'), '/docs/secret\n');
      writeFileSync(join(contentDir, 'docs', 'secret'), SECRET);
      await restartWithTracked(['docs/secret?.png']);
      const res = await fetch(`${harness.baseURL}/docs/SECRET%3F.png`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(SECRET);
    });

    test('a tracked name holding ? or # is never answered with the bytes of its prefix', async () => {
      writeFileSync(join(contentDir, 'docs', 'chart'), 'chart-prefix-bytes');
      writeFileSync(join(contentDir, 'docs', 'C'), 'c-prefix-bytes');
      await restartWithTracked(['docs/chart?.png', 'docs/C#.png']);
      const answers: string[] = [];
      for (const path of ['/docs/CHART%3F.png', '/docs/c%23.png']) {
        const res = await fetch(`${harness.baseURL}${path}`);
        answers.push(`${path} ${res.status} ${await res.text()}`);
      }
      expect(answers).toEqual(['/docs/CHART%3F.png 404 ', '/docs/c%23.png 404 ']);
    });
  });
});
