import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type AssetServeFilter,
  createAssetServeMiddleware,
  type SirvLikeMiddleware,
} from './asset-serve-middleware.ts';
import { buildIngressPolicy } from './ingress-policy.ts';

function makeReq(url: string, host = 'localhost'): IncomingMessage {
  const readable = Readable.from(Buffer.alloc(0)) as unknown as IncomingMessage;
  readable.method = 'GET';
  readable.url = url;
  readable.headers = { host };
  return readable;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  headersSent: boolean;
  ended: boolean;
  body: string;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    status: 0,
    headers: {},
    headersSent: false,
    ended: false,
    body: '',
  };
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    removeHeader(name: string) {
      delete captured.headers[name];
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headersSent = true;
      if (headers) Object.assign(captured.headers, headers);
    },
    end(body?: string) {
      captured.ended = true;
      if (typeof body === 'string') captured.body = body;
    },
    get headersSent() {
      return captured.headersSent;
    },
    get statusCode() {
      return captured.status;
    },
    set statusCode(value: number) {
      captured.status = value;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

const sirvFallThrough: SirvLikeMiddleware = (_req, _res, fallback) => fallback();

const sirvServes: SirvLikeMiddleware = (_req, res, _fallback) => {
  res.writeHead(200);
  res.end();
};

const admitAll: AssetServeFilter = { isPathIgnored: () => false };

const excludeAll: AssetServeFilter = { isPathIgnored: () => true };

const INLINE = new Set(['png', 'jpg', 'pdf', 'mp4', 'm4v', 'svg']);
const ASSETS = new Set([...INLINE, 'docx', 'csv', 'json', 'txt', 'zip', 'html', 'htm']);
const BLOCKLIST = new Set(['exe', 'dmg', 'sh', 'html', 'htm']);

const SERVABLE_FIXTURES = [
  'photo.png',
  'clip.m4v',
  'data.csv',
  'spec.docx',
  'doc.pdf',
  'icon.svg',
  'trip-viewer.html',
  'legacy.htm',
  'notes.md',
  'Notes.MD',
  'doc.mdx',
  'my file.m4v',
  'payload.dmg',
];

let fixtureDir: string;
let outsideDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'ok-asset-serve-unit-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'ok-asset-serve-outside-'));
  for (const name of SERVABLE_FIXTURES) writeFileSync(join(fixtureDir, name), 'fixture');
  writeFileSync(join(outsideDir, 'secret.png'), 'outside');
  symlinkSync(join(outsideDir, 'secret.png'), join(fixtureDir, 'escape.png'));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

function buildMiddleware(
  sirv: SirvLikeMiddleware,
  filter: AssetServeFilter = admitAll,
  resolveTrackedFile?: (relativePath: string) => string | undefined,
) {
  return createAssetServeMiddleware({
    contentDir: fixtureDir,
    contentFilter: filter,
    contentSirv: sirv,
    inlineExtensions: INLINE,
    assetExtensions: ASSETS,
    blocklistExtensions: BLOCKLIST,
    ingressPolicy: buildIngressPolicy({}),
    resolveTrackedFile,
  });
}

function sirvRecording(urls: string[]): SirvLikeMiddleware {
  return (req, res) => {
    urls.push(req.url ?? '');
    res.writeHead(200);
    res.end();
  };
}

function trackedAlias(alias: string, target: string) {
  return (relativePath: string) => (relativePath === alias ? target : undefined);
}

describe('createAssetServeMiddleware', () => {
  describe('filter exclusion', () => {
    test('excluded path falls through to next() immediately without setting headers', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvServes, excludeAll);
      const { res, captured } = makeRes();
      middleware(makeReq('/foo.m4v'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(captured.headers).toEqual({});
      expect(captured.headersSent).toBe(false);
    });

    test('empty URL path falls through (rel === "")', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvServes);
      const { res } = makeRes();
      middleware(makeReq('/'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    });
  });

  describe('content-serve ingress gate (policy item 0)', () => {
    test('a rebound Host on a servable path is refused without touching sirv', () => {
      let sirvInvoked = false;
      const sirvSpy: SirvLikeMiddleware = (_req, _res, fallback) => {
        sirvInvoked = true;
        fallback();
      };
      const middleware = buildMiddleware(sirvSpy);
      const { res, captured } = makeRes();
      middleware(makeReq('/photo.png', 'evil.example'), res, () => {});
      expect(captured.status).toBe(403);
      expect(JSON.parse(captured.body).type).toBe('urn:ok:error:host-not-allowed');
      expect(sirvInvoked).toBe(false);
      expect(captured.headers['Content-Disposition']).toBeUndefined();
    });

    test('a rebound Host on a doc path (.md) is refused the same way', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/notes.md', 'evil.example'), res, () => {});
      expect(captured.status).toBe(403);
      expect(JSON.parse(captured.body).type).toBe('urn:ok:error:host-not-allowed');
    });

    test('a non-loopback TCP peer on a servable path is refused with loopback-required', () => {
      let sirvInvoked = false;
      const sirvSpy: SirvLikeMiddleware = (_req, _res, fallback) => {
        sirvInvoked = true;
        fallback();
      };
      const middleware = buildMiddleware(sirvSpy);
      const { res, captured } = makeRes();
      const req = makeReq('/photo.png', 'localhost');
      (req as unknown as { socket: { remoteAddress: string } }).socket = {
        remoteAddress: '203.0.113.7',
      };
      middleware(req, res, () => {});
      expect(captured.status).toBe(403);
      expect(JSON.parse(captured.body).type).toBe('urn:ok:error:loopback-required');
      expect(sirvInvoked).toBe(false);
    });

    test('a rebound Host on a NON-servable path still falls through ungated (SPA shell)', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvServes);
      const { res } = makeRes();
      middleware(makeReq('/deep-link', 'evil.example'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    });

    test('a rebound Host on an ignored path falls through ungated too', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvServes, excludeAll);
      const { res } = makeRes();
      middleware(makeReq('/photo.png', 'evil.example'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    });

    test('a loopback Host serves normally through the gate', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/photo.png', '127.0.0.1:5173'), res, () => {});
      expect(captured.status).toBe(200);
      expect(captured.headers['Content-Disposition']).toBe('inline');
    });
  });

  describe('Content-Disposition dispatch', () => {
    test('INLINE_RENDERABLE extension gets `inline` disposition', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/clip.m4v'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBe('inline');
      expect(captured.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    test('admitted non-inline extension gets `attachment` disposition', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/data.csv'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBe('attachment');
      expect(captured.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    test('office doc gets `attachment` (HedgeDoc stored-XSS posture)', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/spec.docx'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBe('attachment');
    });

    test('PDF gets `inline` — browser built-in viewer renders', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/doc.pdf'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBe('inline');
    });

    test('SVG gets `inline` disposition AND a CSP sandbox header (top-level-nav script defense)', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/icon.svg'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBe('inline');
      expect(captured.headers['Content-Security-Policy']).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(captured.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    test('html gets `inline` + sandboxed CSP (opaque origin, no network, no plain inline)', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/trip-viewer.html'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBe('inline');
      expect(captured.headers['Content-Security-Policy']).toBe(
        "sandbox allow-scripts; connect-src 'none'",
      );
      expect(captured.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(captured.headers['Cache-Control']).toBe('no-store');
    });

    test('htm is handled identically to html', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/legacy.htm'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBe('inline');
      expect(captured.headers['Content-Security-Policy']).toBe(
        "sandbox allow-scripts; connect-src 'none'",
      );
    });
  });

  describe('.md / .mdx doc-ext bypass', () => {
    test('.md direct-URL request skips Content-Disposition entirely', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/notes.md'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBeUndefined();
      expect(captured.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    test('.mdx direct-URL request also bypasses disposition', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/doc.mdx'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBeUndefined();
    });

    test('uppercase extensions normalize to lowercase (case-insensitive ext)', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/Notes.MD'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBeUndefined();
    });
  });

  describe('fail-closed 404 guard', () => {
    test('sirv fall-through on ASSET_EXTENSIONS path returns 404, not next()', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvFallThrough);
      const { res, captured } = makeRes();
      middleware(makeReq('/missing.m4v'), res, () => {
        nextCalled = true;
      });
      expect(captured.status).toBe(404);
      expect(captured.ended).toBe(true);
      expect(nextCalled).toBe(false);
    });

    test('html MISS falls through clean (no 404, and sandbox CSP stripped) so the SPA shell serves', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvFallThrough);
      const { res, captured } = makeRes();
      middleware(makeReq('/index.html'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(captured.status).not.toBe(404);
      expect(captured.headers['Content-Security-Policy']).toBeUndefined();
      expect(captured.headers['Content-Disposition']).toBeUndefined();
      expect(captured.headers['X-Content-Type-Options']).toBeUndefined();
      expect(captured.headers['Cache-Control']).toBeUndefined();
    });

    test('EXECUTABLE_BLOCKLIST extension (not also an asset extension) falls through to next() before sirv', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvFallThrough);
      const { res, captured } = makeRes();
      middleware(makeReq('/malicious.dmg'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(captured.status).toBe(0);
      expect(captured.headers).toEqual({});
    });

    test('unknown extension falls through to next() before sirv (not a servable content extension)', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvFallThrough);
      const { res, captured } = makeRes();
      middleware(makeReq('/route.unknown'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(captured.headers).toEqual({});
      expect(captured.status).toBe(0);
      expect(captured.ended).toBe(false);
    });

    test('sirv fall-through on .md falls through to next() (doc-path, not asset)', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvFallThrough);
      const { res, captured } = makeRes();
      middleware(makeReq('/missing.md'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(captured.status).toBe(0);
    });

    test('404 guard is skipped if sirv already sent headers (race safety)', () => {
      const sirvRaced: SirvLikeMiddleware = (_req, res, fallback) => {
        res.writeHead(200);
        fallback();
      };
      let nextCalled = false;
      const middleware = buildMiddleware(sirvRaced);
      const { res, captured } = makeRes();
      middleware(makeReq('/clip.m4v'), res, () => {
        nextCalled = true;
      });
      expect(captured.status).toBe(200);
      expect(nextCalled).toBe(false);
    });
  });

  describe('URL parsing', () => {
    test('query string is stripped from relative path', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/clip.m4v?t=42'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBe('inline');
    });

    test('URL-encoded path is decoded', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/my%20file.m4v'), res, () => {});
      expect(captured.headers['Content-Disposition']).toBe('inline');
    });

    test('extensionless path falls through to next() (not a servable content extension)', () => {
      let nextCalled = false;
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      middleware(makeReq('/README'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(captured.headers).toEqual({});
    });

    test('malformed percent-encoding (`/%`) falls through to next() — URIError caught', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      let nextCalled = false;
      middleware(makeReq('/%'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(captured.headers['Content-Disposition']).toBeUndefined();
      expect(captured.status).toBe(0);
    });

    test('malformed multi-byte sequence (`/%E0%A4`) falls through to next()', () => {
      const middleware = buildMiddleware(sirvServes);
      const { res, captured } = makeRes();
      let nextCalled = false;
      middleware(makeReq('/%E0%A4'), res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(captured.headers['Content-Disposition']).toBeUndefined();
    });
  });

  describe('tracked-file fallback on an exact miss', () => {
    test('serves the tracked file the resolver names and keeps the query string', () => {
      const urls: string[] = [];
      const middleware = buildMiddleware(
        sirvRecording(urls),
        admitAll,
        trackedAlias('Alias/Photo.png', 'photo.png'),
      );
      const { res, captured } = makeRes();
      let nextCalled = false;
      middleware(makeReq('/Alias/Photo.png?v=2'), res, () => {
        nextCalled = true;
      });
      expect(urls).toEqual(['/photo.png?v=2']);
      expect(captured.status).toBe(200);
      expect(captured.headers['Content-Disposition']).toBe('inline');
      expect(nextCalled).toBe(false);
    });

    test('encodes the resolved spelling so the static server looks up its exact bytes', () => {
      const urls: string[] = [];
      const middleware = buildMiddleware(
        sirvRecording(urls),
        admitAll,
        trackedAlias('alias.m4v', 'my file.m4v'),
      );
      const { res, captured } = makeRes();
      middleware(makeReq('/alias.m4v'), res, () => {});
      expect(urls).toEqual(['/my%20file.m4v']);
      expect(captured.status).toBe(200);
    });

    test('disposition and CSP follow the resolved file rather than the requested spelling', () => {
      const svg = buildMiddleware(sirvServes, admitAll, trackedAlias('alias.png', 'icon.svg'));
      const svgRes = makeRes();
      svg(makeReq('/alias.png'), svgRes.res, () => {});
      expect(svgRes.captured.status).toBe(200);
      expect(svgRes.captured.headers['Content-Security-Policy']).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );

      const csv = buildMiddleware(sirvServes, admitAll, trackedAlias('alias.png', 'data.csv'));
      const csvRes = makeRes();
      csv(makeReq('/alias.png'), csvRes.res, () => {});
      expect(csvRes.captured.status).toBe(200);
      expect(csvRes.captured.headers['Content-Disposition']).toBe('attachment');
    });

    test('the resolver is not consulted when the requested spelling exists', () => {
      const asked: string[] = [];
      const middleware = buildMiddleware(sirvServes, admitAll, (relativePath) => {
        asked.push(relativePath);
        return undefined;
      });
      const { res, captured } = makeRes();
      middleware(makeReq('/photo.png'), res, () => {});
      expect(captured.status).toBe(200);
      expect(asked).toEqual([]);
    });

    test('a resolved file the content filter ignores is not served', () => {
      const urls: string[] = [];
      const middleware = buildMiddleware(
        sirvRecording(urls),
        { isPathIgnored: (relativePath) => relativePath === 'photo.png' },
        trackedAlias('alias.png', 'photo.png'),
      );
      const { res, captured } = makeRes();
      middleware(makeReq('/alias.png'), res, () => {});
      expect(urls).toEqual([]);
      expect(captured.status).toBe(404);
    });

    test('a resolved file outside the servable asset extensions is not served', () => {
      const urls: string[] = [];
      const middleware = buildMiddleware(
        sirvRecording(urls),
        admitAll,
        trackedAlias('alias.png', 'payload.dmg'),
      );
      const { res, captured } = makeRes();
      middleware(makeReq('/alias.png'), res, () => {});
      expect(urls).toEqual([]);
      expect(captured.status).toBe(404);
    });

    test('a resolved symlink that escapes the content directory is not served', () => {
      const urls: string[] = [];
      const middleware = buildMiddleware(
        sirvRecording(urls),
        admitAll,
        trackedAlias('link-alias.png', 'escape.png'),
      );
      const { res, captured } = makeRes();
      middleware(makeReq('/link-alias.png'), res, () => {});
      expect(urls).toEqual([]);
      expect(captured.status).toBe(404);
    });

    test('a resolved name no URL can spell is refused rather than thrown on', () => {
      const urls: string[] = [];
      const middleware = buildMiddleware(
        sirvRecording(urls),
        admitAll,
        trackedAlias('alias.png', '\uD800.png'),
      );
      const { res, captured } = makeRes();
      middleware(makeReq('/alias.png'), res, () => {});
      expect(urls).toEqual([]);
      expect(captured.status).toBe(404);
    });

    test('a markdown request never falls back to a tracked file', () => {
      const urls: string[] = [];
      const middleware = buildMiddleware(
        sirvRecording(urls),
        admitAll,
        trackedAlias('missing.md', 'notes.md'),
      );
      const { res } = makeRes();
      let nextCalled = false;
      middleware(makeReq('/missing.md'), res, () => {
        nextCalled = true;
      });
      expect(urls).toEqual([]);
      expect(nextCalled).toBe(true);
    });

    test('an html fall-through after a resolved hit restores the requested URL for the SPA shell', () => {
      const middleware = buildMiddleware(
        sirvFallThrough,
        admitAll,
        trackedAlias('Viewer.html', 'trip-viewer.html'),
      );
      const { res } = makeRes();
      const req = makeReq('/Viewer.html');
      let urlAtNext: string | undefined;
      middleware(req, res, () => {
        urlAtNext = req.url;
      });
      expect(urlAtNext).toBe('/Viewer.html');
    });
  });
});
