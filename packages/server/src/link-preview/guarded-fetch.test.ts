import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  guardedFetch,
  type HostResolver,
} from './guarded-fetch.ts';
import { isPublicUnicastIp } from './ip-classifier.ts';

// Force a hostname to a chosen address so the real validator can be exercised
// without touching DNS. Anything that isn't a named internal host resolves to
// the loopback rig.
const forceResolve =
  (map: Record<string, string>): HostResolver =>
  async (hostname) => {
    const address = map[hostname] ?? '127.0.0.1';
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  };

describe('guardedFetch admission (real classifier, no network reached)', () => {
  test.each([
    'ftp://example.com/',
    'file:///etc/passwd',
    'gopher://example.com/',
    'data:text/html,x',
  ])('rejects non-http(s) scheme %p as bad-scheme', async (url) => {
    expect(await guardedFetch(url)).toEqual({ ok: false, reason: 'bad-scheme' });
  });

  test.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://[::1]/',
    // Encoded loopback spellings the classifier canonicalizes before deciding.
    'http://0x7f000001/',
    'http://2130706433/',
    'http://0177.0.0.1/',
  ])('rejects private/reserved IP literal %p as private-ip', async (url) => {
    expect(await guardedFetch(url)).toEqual({ ok: false, reason: 'private-ip' });
  });

  test('rejects a public hostname that DNS-resolves to loopback (no address override → real guard)', async () => {
    const result = await guardedFetch('http://totally-public.example/', {
      resolve: forceResolve({ 'totally-public.example': '127.0.0.1' }),
    });
    expect(result).toEqual({ ok: false, reason: 'private-ip' });
  });

  test('rejects a public hostname that resolves to a link-local metadata address', async () => {
    const result = await guardedFetch('http://metadata.example/', {
      resolve: forceResolve({ 'metadata.example': '169.254.169.254' }),
    });
    expect(result).toEqual({ ok: false, reason: 'private-ip' });
  });

  test('rejects when ANY resolved record is private, even if another is public', async () => {
    const resolve: HostResolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    expect(await guardedFetch('http://mixed.example/', { resolve })).toEqual({
      ok: false,
      reason: 'private-ip',
    });
  });

  test('rejects an empty DNS resolution as dns-failure', async () => {
    const resolve: HostResolver = async () => [];
    expect(await guardedFetch('http://void.example/', { resolve })).toEqual({
      ok: false,
      reason: 'dns-failure',
    });
  });

  test('rejects a DNS resolution error as dns-failure', async () => {
    const resolve: HostResolver = async () => {
      throw new Error('NXDOMAIN');
    };
    expect(await guardedFetch('http://broken-dns.example/', { resolve })).toEqual({
      ok: false,
      reason: 'dns-failure',
    });
  });

  test('rejects an unparseable URL as fetch-error', async () => {
    expect(await guardedFetch('not a url')).toEqual({ ok: false, reason: 'fetch-error' });
  });

  test('caps are the specified defaults', () => {
    expect(DEFAULT_MAX_BYTES).toBe(512 * 1024);
    expect(DEFAULT_TIMEOUT_MS).toBe(5000);
    expect(DEFAULT_MAX_REDIRECTS).toBe(3);
  });
});

describe('guardedFetch against a loopback rig (real socket)', () => {
  let server: Server;
  let port: number;
  let lastRequest: {
    host?: string;
    ua?: string;
    acceptEncoding?: string;
    cookie?: string;
    authorization?: string;
    referer?: string;
  } | null = null;

  // The rig binds loopback; a public hostname resolves to it via the injected
  // resolver, and the guard is told to treat that one loopback address as
  // public so post-admission behavior can be exercised over a real socket.
  // Every OTHER address (including redirect targets) still runs the real
  // classifier, so the SSRF property is decided by the real guard.
  const rigResolver = forceResolve({ 'internal.example': '10.0.0.1' });
  const allowRigLoopback = (ip: string) => ip === '127.0.0.1' || isPublicUnicastIp(ip);
  const withRig = { resolve: rigResolver, isAddressAllowed: allowRigLoopback };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      if (path === '/ok') {
        lastRequest = {
          host: req.headers.host,
          ua: req.headers['user-agent'],
          acceptEncoding: req.headers['accept-encoding'],
          cookie: req.headers.cookie,
          authorization: req.headers.authorization,
          referer: req.headers.referer,
        };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('hello');
        return;
      }
      if (path === '/redirect-once') {
        res.writeHead(302, { Location: '/final' });
        res.end();
        return;
      }
      if (path === '/final') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('final page');
        return;
      }
      if (path === '/redirect-internal-literal') {
        res.writeHead(302, { Location: 'http://169.254.169.254/' });
        res.end();
        return;
      }
      if (path === '/redirect-internal-host') {
        res.writeHead(302, { Location: 'http://internal.example/' });
        res.end();
        return;
      }
      if (path === '/loop') {
        res.writeHead(302, { Location: '/loop' });
        res.end();
        return;
      }
      if (path === '/redirect-no-location') {
        res.writeHead(302);
        res.end();
        return;
      }
      if (path === '/oversized') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('x'.repeat(4096));
        return;
      }
      if (path === '/gzip') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.end(gzipSync('<html>compressed hello</html>'));
        return;
      }
      if (path === '/gzip-bomb') {
        // Tiny on the wire, far past the cap once decompressed — the guard
        // must count DECOMPRESSED bytes to catch it.
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.end(gzipSync('x'.repeat(64 * 1024)));
        return;
      }
      if (path === '/unknown-encoding') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'zstd' });
        res.end('opaque');
        return;
      }
      if (path === '/nonhtml') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"not":"html"}');
        return;
      }
      if (path === '/slow') {
        const timer = setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('too late');
          }
        }, 2000);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    ({ port } = await listenOnLoopback(server));
  });

  afterAll(() => {
    server.close();
  });

  test('allows a public-resolving host and returns the pinned response', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/ok`, withRig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentType).toBe('text/html');
    expect(new TextDecoder().decode(result.body)).toBe('hello');
    expect(result.finalUrl).toBe(`http://rig.example:${port}/ok`);
  });

  test('pins the connection while preserving Host and sending no credentials', async () => {
    lastRequest = null;
    const result = await guardedFetch(`http://rig.example:${port}/ok`, withRig);
    expect(result.ok).toBe(true);
    // The socket connected to the validated IP but the Host header carries the
    // original name — proof the pin swapped the connect target, not the identity.
    expect(lastRequest?.host).toBe(`rig.example:${port}`);
    expect(lastRequest?.ua).toBe('OpenKnowledge-LinkPreview/1.x');
    expect(lastRequest?.cookie).toBeUndefined();
    expect(lastRequest?.authorization).toBeUndefined();
    expect(lastRequest?.referer).toBeUndefined();
  });

  test('requests an identity encoding (transport does not auto-negotiate compression)', async () => {
    lastRequest = null;
    const result = await guardedFetch(`http://rig.example:${port}/ok`, withRig);
    expect(result.ok).toBe(true);
    expect(lastRequest?.acceptEncoding).toBe('identity');
  });

  test('drops URL userinfo instead of forwarding it as credentials', async () => {
    lastRequest = null;
    const result = await guardedFetch(`http://user:secret@rig.example:${port}/ok`, withRig);
    expect(result.ok).toBe(true);
    expect(lastRequest?.authorization).toBeUndefined();
  });

  test('decompresses a gzip response that ignored Accept-Encoding: identity', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/gzip`, withRig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body)).toBe('<html>compressed hello</html>');
  });

  test('caps the DECOMPRESSED size, not the wire size (gzip-bomb guard)', async () => {
    // The compressed payload is well under the cap; only decompressed
    // accounting can reject it.
    const result = await guardedFetch(`http://rig.example:${port}/gzip-bomb`, {
      ...withRig,
      maxBytes: 8 * 1024,
    });
    expect(result).toEqual({ ok: false, reason: 'oversized' });
  });

  test('rejects a content-encoding it cannot size-guard', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/unknown-encoding`, withRig);
    expect(result).toEqual({ ok: false, reason: 'fetch-error' });
  });

  test('follows a same-host redirect within the hop limit', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/redirect-once`, withRig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body)).toBe('final page');
    expect(result.finalUrl).toBe(`http://rig.example:${port}/final`);
  });

  test('rejects a redirect to an internal IP literal (re-validated per hop)', async () => {
    const result = await guardedFetch(
      `http://rig.example:${port}/redirect-internal-literal`,
      withRig,
    );
    expect(result).toEqual({ ok: false, reason: 'private-ip' });
  });

  test('rejects a redirect to a host that resolves internally', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/redirect-internal-host`, withRig);
    expect(result).toEqual({ ok: false, reason: 'private-ip' });
  });

  test('rejects a 3xx without a Location header as fetch-error', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/redirect-no-location`, withRig);
    expect(result).toEqual({ ok: false, reason: 'fetch-error' });
  });

  test('rejects a redirect chain that exceeds the hop limit', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/loop`, {
      ...withRig,
      maxRedirects: 1,
    });
    expect(result).toEqual({ ok: false, reason: 'redirect-limit' });
  });

  test('aborts a response body that exceeds the size cap', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/oversized`, {
      ...withRig,
      maxBytes: 1024,
    });
    expect(result).toEqual({ ok: false, reason: 'oversized' });
  });

  test('rejects a non-HTML content type', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/nonhtml`, withRig);
    expect(result).toEqual({ ok: false, reason: 'non-html' });
  });

  test('allows a non-HTML content type when the predicate opts in (favicon reuse)', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/nonhtml`, {
      ...withRig,
      allowContentType: (mimeType) => mimeType === 'application/json',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentType).toBe('application/json');
  });

  test('times out a slow response', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/slow`, {
      ...withRig,
      timeoutMs: 200,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });
});
