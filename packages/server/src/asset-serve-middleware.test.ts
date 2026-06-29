import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  type AssetServeFilter,
  createAssetServeMiddleware,
  type SirvLikeMiddleware,
} from './asset-serve-middleware.ts';

function makeReq(url: string): IncomingMessage {
  const readable = Readable.from(Buffer.alloc(0)) as unknown as IncomingMessage;
  readable.method = 'GET';
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  headersSent: boolean;
  ended: boolean;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, headersSent: false, ended: false };
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
    end(_body?: string) {
      captured.ended = true;
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

function buildMiddleware(sirv: SirvLikeMiddleware, filter: AssetServeFilter = admitAll) {
  return createAssetServeMiddleware({
    contentFilter: filter,
    contentSirv: sirv,
    inlineExtensions: INLINE,
    assetExtensions: ASSETS,
    blocklistExtensions: BLOCKLIST,
  });
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
});
