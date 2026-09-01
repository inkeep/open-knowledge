import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import {
  createHeadEndScanner,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  guardedFetch,
  type HostResolver,
} from './guarded-fetch.ts';
import { isPublicUnicastIp } from './ip-classifier.ts';

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

describe('createHeadEndScanner (chunk-boundary-safe head-end detection)', () => {
  const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));

  test('finds </head> within a single chunk and reports the offset past it', () => {
    const scan = createHeadEndScanner();
    const html = '<html><head><title>t</title></head><body>x</body>';
    expect(scan(bytes(html))).toBe(html.indexOf('</head>') + '</head>'.length);
  });

  test.each([
    1, 2, 3, 4, 5, 6,
  ])('finds </head> split across a chunk boundary after %i marker byte(s)', (splitAt) => {
    const scan = createHeadEndScanner();
    const marker = '</head>';
    expect(scan(bytes(`<html><head><title>t</title>${marker.slice(0, splitAt)}`))).toBe(-1);
    const rest = `${marker.slice(splitAt)}<body>tail`;
    expect(scan(bytes(rest))).toBe(marker.length - splitAt);
  });

  test('finds an opening <body> when no </head> precedes it', () => {
    const scan = createHeadEndScanner();
    const html = '<html><head><title>t</title><body>x';
    expect(scan(bytes(html))).toBe(html.indexOf('<body') + '<body'.length + 1);
  });

  test('finds an opening <body with attributes (whitespace terminator)', () => {
    const scan = createHeadEndScanner();
    const html = '<html><head><body class="a">x';
    expect(scan(bytes(html))).toBe(html.indexOf('<body') + '<body '.length);
  });

  test('finds <body split across a chunk boundary', () => {
    const scan = createHeadEndScanner();
    expect(scan(bytes('<html><head><title>t</title><bo'))).toBe(-1);
    expect(scan(bytes('dy>tail'))).toBe(3);
  });

  test('holds a chunk-final bare <body until the next chunk settles its terminator', () => {
    const scan = createHeadEndScanner();
    expect(scan(bytes('<html><head><body'))).toBe(-1);
    expect(scan(bytes('>x'))).toBe(1);
  });

  test('is ASCII case-insensitive (</HEAD>, <BODY>)', () => {
    const upperHead = createHeadEndScanner();
    expect(upperHead(bytes('<HTML><HEAD><TITLE>T</TITLE></HEAD>'))).toBe(
      '<HTML><HEAD><TITLE>T</TITLE></HEAD>'.length,
    );
    const upperBody = createHeadEndScanner();
    expect(upperBody(bytes('<HTML><BODY>x'))).toBe('<HTML><BODY'.length + 1);
  });

  test('reports the earlier marker when a <body opens before a later </head>', () => {
    const scan = createHeadEndScanner();
    const html = '<x><body>then</head>';
    expect(scan(bytes(html))).toBe(html.indexOf('<body') + '<body'.length + 1);
  });

  test('does not match a custom element like <bodyguard>, even across chunks', () => {
    const scan = createHeadEndScanner();
    expect(scan(bytes('<html><bodyg'))).toBe(-1);
    expect(scan(bytes('uard>content'))).toBe(-1);
  });

  test('returns -1 across many marker-free chunks', () => {
    const scan = createHeadEndScanner();
    for (let i = 0; i < 20; i++) {
      expect(scan(bytes('<p>plain markup with heads and bodies spelled out</p>'))).toBe(-1);
    }
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

  const HUGE_PAGE_HEAD =
    '<html><head><title>Huge Page</title><meta name="description" content="streams forever"></head>';
  let hugeStream = { closedEarly: false, finishedAll: false };
  let hugeClosed: Promise<void> = Promise.resolve();

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
      if (path === '/huge-streaming') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write(HUGE_PAGE_HEAD);
        const observed = { closedEarly: false, finishedAll: false };
        hugeStream = observed;
        const closed = Promise.withResolvers<void>();
        hugeClosed = closed.promise;
        const filler = Buffer.alloc(64 * 1024, 0x78);
        let written = 0;
        const timer = setInterval(() => {
          if (res.destroyed || res.writableEnded) return;
          if (written >= 8 * 1024 * 1024) {
            observed.finishedAll = true;
            clearInterval(timer);
            res.end();
            return;
          }
          written += filler.byteLength;
          res.write(filler);
        }, 1);
        res.on('close', () => {
          clearInterval(timer);
          if (!res.writableFinished) observed.closedEarly = true;
          closed.resolve();
        });
        return;
      }
      if (path === '/marker-in-head-script') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<html><head><script>var s='</head><body>';</script>` +
            `<title>RealTitle</title></head><body>${'z'.repeat(1024)}</body></html>`,
        );
        return;
      }
      if (path === '/head-end-past-cap-multichunk') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('a'.repeat(80));
        setTimeout(() => res.end(`${'b'.repeat(37)}</head>tail`), 20);
        return;
      }
      if (path === '/head-split-across-writes') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<html><head><title>Split</title></he');
        setTimeout(() => res.end('ad><body>after the boundary</body>'), 20);
        return;
      }
      if (path === '/body-open-no-head-close') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>NoClose</title><body class="x">${'y'.repeat(64 * 1024)}`);
        return;
      }
      if (path === '/upper-head') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<HTML><HEAD><TITLE>Caps</TITLE></HEAD><BODY>${'z'.repeat(64 * 1024)}`);
        return;
      }
      if (path === '/marker-after-cap') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`${'x'.repeat(2048)}</head>`);
        return;
      }
      if (path === '/small-no-markers') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><title>Whole</title><p>every byte returned</p>');
        return;
      }
      if (path === '/json-with-marker-bytes') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"snippet":"</head><body>","trailer":"kept"}');
        return;
      }
      if (path === '/gzip-huge-head-first') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.end(
          gzipSync(`<html><head><title>Zipped</title></head><body>${'w'.repeat(200 * 1024)}`),
        );
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

  test('succeeds on a huge streaming page whose head arrives first, cancelling the rest', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/huge-streaming`, withRig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body)).toBe(HUGE_PAGE_HEAD);
    expect(result.body.byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 2000);
    });
    const outcome = await Promise.race([hugeClosed.then(() => 'closed' as const), timeout]);
    clearTimeout(timer);
    expect(outcome).toBe('closed');
    expect(hugeStream.closedEarly).toBe(true);
    expect(hugeStream.finishedAll).toBe(false);
  });

  test('keeps the real head when a </head> is spelled inside a head-level <script>', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/marker-in-head-script`, withRig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = new TextDecoder().decode(result.body);
    expect(body).toBe(
      "<html><head><script>var s='</head><body>';</script><title>RealTitle</title></head>",
    );
  });

  test('detects a </head> split across two response writes', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/head-split-across-writes`, {
      ...withRig,
      maxBytes: 4 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body)).toBe('<html><head><title>Split</title></head>');
  });

  test('terminates at an opening <body when the page never closes its head', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/body-open-no-head-close`, {
      ...withRig,
      maxBytes: 4 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body)).toBe('<html><head><title>NoClose</title><body ');
  });

  test('matches head-end case-insensitively (</HEAD>)', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/upper-head`, {
      ...withRig,
      maxBytes: 4 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body)).toBe('<HTML><HEAD><TITLE>Caps</TITLE></HEAD>');
  });

  test('still rejects as oversized when the cap is reached before head-end', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/marker-after-cap`, {
      ...withRig,
      maxBytes: 1024,
    });
    expect(result).toEqual({ ok: false, reason: 'oversized' });
  });

  test('rejects as oversized when head-end clears the cap only after earlier chunks count', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/head-end-past-cap-multichunk`, {
      ...withRig,
      maxBytes: 100,
    });
    expect(result).toEqual({ ok: false, reason: 'oversized' });
  });

  test('returns an under-cap page with no head markers whole, as before', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/small-no-markers`, withRig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body)).toBe(
      '<html><title>Whole</title><p>every byte returned</p>',
    );
  });

  test('reads non-HTML content in full even when it contains marker-shaped bytes', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/json-with-marker-bytes`, {
      ...withRig,
      allowContentType: (mimeType) => mimeType === 'application/json',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body)).toBe(
      '{"snippet":"</head><body>","trailer":"kept"}',
    );
  });

  test('applies the head-end scan to DECOMPRESSED bytes (gzip page far past the cap)', async () => {
    const result = await guardedFetch(`http://rig.example:${port}/gzip-huge-head-first`, {
      ...withRig,
      maxBytes: 8 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.body)).toBe('<html><head><title>Zipped</title></head>');
  });
});
