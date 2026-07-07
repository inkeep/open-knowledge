/**
 * Tests for the in-process embed-detection ring buffer + diagnostic
 * endpoint wiring.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { AgentSessionManager } from './agent-sessions.ts';
import { createApiExtension } from './api-extension.ts';
import {
  deriveDetection,
  EMBED_PROBE_CAPACITY,
  type EmbedProbeEntry,
  embedProbeRing,
  RingBuffer,
  recordEmbedProbe,
} from './embed-probe.ts';

function makeGetReq(
  url: string,
  opts: {
    remoteAddress?: string;
    host?: string;
    userAgent?: string;
    referer?: string;
    secChUa?: string;
  } = {},
): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  readable.method = 'GET';
  readable.url = url;
  const headers: Record<string, string> = { host: opts.host ?? 'localhost' };
  if (opts.userAgent !== undefined) headers['user-agent'] = opts.userAgent;
  if (opts.referer !== undefined) headers.referer = opts.referer;
  if (opts.secChUa !== undefined) headers['sec-ch-ua'] = opts.secChUa;
  readable.headers = headers;
  (readable as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  };
  return readable;
}

// Convenience: build a minimal EmbedProbeEntry for unit tests that only
// care about specific fields. ts/url/method are required by the type.
function entry(partial: Partial<EmbedProbeEntry>): EmbedProbeEntry {
  return {
    ts: partial.ts ?? Date.now(),
    url: partial.url ?? '/api/__embed-detect',
    method: partial.method ?? 'GET',
    ...partial,
  };
}

interface CapturedResponse {
  status: number;
  body: string;
}

function makeRes(): {
  res: ServerResponse;
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    setHeader() {
      // no-op for tests; onRequest sets a handful of CORS headers for /api/* paths
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
    get headersSent() {
      return false;
    },
    get writableEnded() {
      return false;
    },
    get destroyed() {
      return false;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

describe('RingBuffer', () => {
  test('returns empty array when no entries pushed', () => {
    const buf = new RingBuffer<number>(4);
    expect(buf.read()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  test('returns entries newest-first while under capacity', () => {
    const buf = new RingBuffer<number>(4);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.read()).toEqual([3, 2, 1]);
    expect(buf.size).toBe(3);
  });

  test('returns full capacity newest-first once filled exactly', () => {
    const buf = new RingBuffer<number>(4);
    for (let i = 1; i <= 4; i++) buf.push(i);
    expect(buf.read()).toEqual([4, 3, 2, 1]);
    expect(buf.size).toBe(4);
  });

  test('drops oldest entries once capacity exceeded', () => {
    const buf = new RingBuffer<number>(4);
    for (let i = 1; i <= 6; i++) buf.push(i);
    expect(buf.read()).toEqual([6, 5, 4, 3]);
    expect(buf.size).toBe(4);
  });

  test('holds most recent 256 of 300 pushes in newest-first order', () => {
    const buf = new RingBuffer<number>(256);
    for (let i = 1; i <= 300; i++) buf.push(i);
    const snapshot = buf.read();
    expect(snapshot.length).toBe(256);
    expect(snapshot[0]).toBe(300);
    expect(snapshot[snapshot.length - 1]).toBe(45);
    expect(buf.size).toBe(256);
  });

  test('rejects non-positive or non-integer capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(-1)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(2.5)).toThrow(RangeError);
  });

  test('read snapshot is independent of subsequent pushes', () => {
    const buf = new RingBuffer<number>(4);
    buf.push(1);
    buf.push(2);
    const snap = buf.read();
    buf.push(3);
    expect(snap).toEqual([2, 1]);
  });
});

describe('deriveDetection — eager OR-of-globally-unique classification', () => {
  test('returns empty verdict for undefined entry (empty buffer)', () => {
    expect(deriveDetection(undefined)).toEqual({
      app: null,
      signals_fired: [],
    });
  });

  test('returns empty verdict when no signal-bearing fields are present', () => {
    expect(deriveDetection(entry({}))).toEqual({
      app: null,
      signals_fired: [],
    });
  });

  // ---------------------------------------------------------------------
  // Cursor — UA regex + ?strategy=C_iframe referer literal
  // (both empirically observed firing across all 3 sessions)
  // ---------------------------------------------------------------------

  test('classifies Cursor eagerly when UA regex fires alone', () => {
    const out = deriveDetection(entry({ ua: 'Mozilla/5.0 Cursor/3.4.20 Electron/39.8.1' }));
    expect(out.app).toBe('cursor');
    expect(out.signals_fired).toContain('cursor_ua_regex');
  });

  test('classifies Cursor eagerly when only ?strategy=C_iframe referer fires (no UA)', () => {
    const out = deriveDetection(entry({ referer: 'http://localhost:39847/?strategy=C_iframe' }));
    expect(out.app).toBe('cursor');
    expect(out.signals_fired).toContain('cursor_referer_strategy_iframe');
    expect(out.signals_fired).not.toContain('cursor_ua_regex');
  });

  test('records BOTH Cursor signals when both fire', () => {
    const out = deriveDetection(
      entry({
        ua: 'Cursor/3.4.20 Electron/39.8.1',
        referer: 'http://localhost:39847/?strategy=C_iframe',
      }),
    );
    expect(out.app).toBe('cursor');
    expect(out.signals_fired).toEqual(
      expect.arrayContaining(['cursor_ua_regex', 'cursor_referer_strategy_iframe']),
    );
  });

  test('detects Cursor Dev-flavor parenthetical UA', () => {
    const out = deriveDetection(entry({ ua: 'Mozilla/5.0 Cursor(Beta)/2.0.0 (...)' }));
    expect(out.app).toBe('cursor');
    expect(out.signals_fired).toContain('cursor_ua_regex');
  });

  // ---------------------------------------------------------------------
  // Codex — UA regex (the only globally-unique server-side signal
  // empirically observed for Codex)
  // ---------------------------------------------------------------------

  test('classifies Codex eagerly via UA regex', () => {
    const out = deriveDetection(entry({ ua: 'Codex/0.42.1 (Macintosh; arm64)' }));
    expect(out.app).toBe('codex');
    expect(out.signals_fired).toContain('codex_ua_regex');
  });

  test('OQ-EP1: detects Codex Dev-flavor parenthetical UA', () => {
    const out = deriveDetection(entry({ ua: 'Codex(Dev)/26.513.31313 (Macintosh; arm64)' }));
    expect(out.app).toBe('codex');
    expect(out.signals_fired).toContain('codex_ua_regex');
  });

  // ---------------------------------------------------------------------
  // Claude — UA regex only (UA shape known from real Claude version
  // metadata; embed-context not realized today but the
  // regex is correct for when it does)
  // ---------------------------------------------------------------------

  test('classifies Claude eagerly via UA regex', () => {
    const out = deriveDetection(entry({ ua: 'Claude/0.13.0 (claude-code; cli)' }));
    expect(out.app).toBe('claude');
    expect(out.signals_fired).toContain('claude_ua_regex');
  });

  test('detects Claude Canary-flavor parenthetical UA', () => {
    const out = deriveDetection(entry({ ua: 'Claude(Canary)/1.0.0 (...)' }));
    expect(out.app).toBe('claude');
    expect(out.signals_fired).toContain('claude_ua_regex');
  });

  // ---------------------------------------------------------------------
  // Negatives
  // ---------------------------------------------------------------------

  test('plain Chrome UA → app: null', () => {
    const out = deriveDetection(
      entry({
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      }),
    );
    expect(out.app).toBeNull();
    expect(out.signals_fired).toEqual([]);
  });

  test('UA missing version digit does NOT match Cursor regex', () => {
    const out = deriveDetection(entry({ ua: 'Mozilla/5.0 Cursor (...)' }));
    expect(out.app).toBeNull();
  });

  test('generic Electron app UA (not one of the three) → app: null', () => {
    // `Electron/` UA token alone is NOT a detector signal — catches
    // arbitrary Electron apps that aren't our three integrations. The
    // detector only classifies if a per-app marker fires.
    const out = deriveDetection(entry({ ua: 'Mozilla/5.0 SomeOtherApp/1.0 Electron/30.0.1' }));
    expect(out.app).toBeNull();
    expect(out.signals_fired).toEqual([]);
  });

  test('Sec-CH-UA lacking "Google Chrome" alone → app: null (catches Brave/Edge/Vivaldi too)', () => {
    // The Sec-CH-UA brand-shape check used to be in an `electron-other`
    // fallback; removed because it catches Brave / Edge / Vivaldi /
    // Arc / Opera which aren't embedded webviewers we're detecting.
    const out = deriveDetection(entry({ secChUa: '"Chromium";v="142", "Not_A Brand";v="99"' }));
    expect(out.app).toBeNull();
    expect(out.signals_fired).toEqual([]);
  });

  test('Anthropic-dormant cowork-artifact:// referer alone → app: null', () => {
    // Custom Anthropic schemes (cowork-artifact, cowork-file,
    // claude-simulator) are feature-flag-gated in Claude.app 1.8089.1
    // and have NEVER been empirically observed firing. Removed from
    // the detector under the "empirical only" discipline.
    const out = deriveDetection(entry({ referer: 'cowork-artifact://artifact-12345/' }));
    expect(out.app).toBeNull();
  });

  test('https://claude.ai/ referer alone → app: null', () => {
    // claude.ai doesn't currently embed OK — was a forward-compat
    // signal, removed under the "empirical only" discipline.
    const out = deriveDetection(entry({ referer: 'https://claude.ai/chat/abc' }));
    expect(out.app).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Precedence — Cursor > Codex > Claude when adversarial multi-fire
  // ---------------------------------------------------------------------

  test('precedence: Cursor wins over Claude when both UA markers fire', () => {
    // Adversarial: a UA claiming both apps. The eager check returns
    // Cursor first per documented precedence.
    const out = deriveDetection(entry({ ua: 'Mozilla/5.0 Cursor/3.4.20 Claude/1.0.0' }));
    expect(out.app).toBe('cursor');
    expect(out.signals_fired).toContain('cursor_ua_regex');
    expect(out.signals_fired).not.toContain('claude_ua_regex');
  });

  test('precedence: Codex wins over Claude when both UA markers fire', () => {
    // Adversarial: a UA claiming both Codex and Claude. The eager check
    // processes Codex before Claude (per the documented Cursor > Codex >
    // Claude order), so Codex wins and the claude branch is never reached
    // (claude_ua_regex is not pushed). A reorder of the two branches would
    // flip this to claude — this test guards that ordering.
    const out = deriveDetection(entry({ ua: 'Mozilla/5.0 Codex/0.42.1 Claude/1.0.0' }));
    expect(out.app).toBe('codex');
    expect(out.signals_fired).toContain('codex_ua_regex');
    expect(out.signals_fired).not.toContain('claude_ua_regex');
  });

  test('precedence: Cursor wins over Codex when both UA markers fire', () => {
    // Completes the pairwise precedence matrix (Cursor > Codex > Claude);
    // Cursor returns first, so the codex branch is never reached.
    const out = deriveDetection(entry({ ua: 'Mozilla/5.0 Cursor/3.4.20 Codex/0.42.1' }));
    expect(out.app).toBe('cursor');
    expect(out.signals_fired).toContain('cursor_ua_regex');
    expect(out.signals_fired).not.toContain('codex_ua_regex');
  });

  // ---------------------------------------------------------------------
  // Empirical fixture (Codex Dev-flavor live)
  // ---------------------------------------------------------------------

  test('empirical Codex(Dev) live capture (Spike B 2026-05-21): app=codex', () => {
    const out = deriveDetection(
      entry({
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Codex(Dev)/26.513.31313 Chrome/148.0.7484.78 Electron/42.0.1 Safari/537.36',
        referer: 'http://127.0.0.1:39847/',
        secChUa: '"Not/A)Brand";v="99", "Chromium";v="148"',
      }),
    );
    expect(out.app).toBe('codex');
    expect(out.signals_fired).toContain('codex_ua_regex');
  });

  // ---------------------------------------------------------------------
  // Empirical fixture (Cursor iframe live)
  // ---------------------------------------------------------------------

  test('empirical Cursor live capture (Spike A 2026-05-21): app=cursor with both signals', () => {
    const out = deriveDetection(
      entry({
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/3.4.20 Chrome/142.0.7444.265 Electron/39.8.1 Safari/537.36',
        referer: 'http://localhost:39847/?strategy=C_iframe',
        secChUa: '"Not_A Brand";v="99", "Chromium";v="142"',
      }),
    );
    expect(out.app).toBe('cursor');
    expect(out.signals_fired).toEqual(
      expect.arrayContaining(['cursor_ua_regex', 'cursor_referer_strategy_iframe']),
    );
  });
});

describe('recordEmbedProbe singleton', () => {
  test('pushes into the module singleton, retrievable via read()', () => {
    const unique = `singleton-test/${randomUUID()}`;
    const entry: EmbedProbeEntry = {
      ts: Date.now(),
      url: `/api/probe-test-${randomUUID()}`,
      method: 'GET',
      ua: unique,
    };
    recordEmbedProbe(entry);
    const found = embedProbeRing.read().find((e) => e.ua === unique);
    expect(found).toBeDefined();
    expect(found?.url).toBe(entry.url);
    expect(found?.method).toBe('GET');
  });

  test('singleton capacity is the documented constant', () => {
    expect(EMBED_PROBE_CAPACITY).toBe(256);
  });
});

describe('onRequest captures into ring buffer + /api/__embed-detect surfaces it', () => {
  function setup() {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-embed-probe-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    const ext = createApiExtension({
      hocuspocus,
      sessionManager,
      contentDir,
      serverInstanceId: randomUUID(),
      getFileIndex: () => new Map(),
    });
    const cleanup = async () => {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    };
    return { ext, cleanup };
  }

  async function dispatch(
    ext: ReturnType<typeof createApiExtension>,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    await (
      ext as unknown as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
  }

  test('captures the request UA into the ring buffer and returns it via /api/__embed-detect', async () => {
    const { ext, cleanup } = setup();
    try {
      const uniqueUa = `EmbedSmokeTest/${randomUUID()}`;
      const uniqueUrl = `/api/__embed-probe-marker-${randomUUID()}`;

      // First request: a synthetic /api/* path that triggers the probe
      // recording but doesn't match any route (404 returned, that's fine —
      // recordEmbedProbe runs before route dispatch).
      const recordReq = makeGetReq(uniqueUrl, { userAgent: uniqueUa });
      const { res: recordRes } = makeRes();
      await dispatch(ext, recordReq, recordRes);

      // Second request: read the probe endpoint with a benign UA so the
      // newest entry the handler derives signals from is the read request
      // itself; we look up our marker entry by its unique UA.
      const readReq = makeGetReq('/api/__embed-detect', { userAgent: 'BenignReader/1.0' });
      const { res: readRes, captured } = makeRes();
      await dispatch(ext, readReq, readRes);

      expect(captured.status).toBe(200);
      const payload = JSON.parse(captured.body) as {
        entries: EmbedProbeEntry[];
        count: number;
        detection: ReturnType<typeof deriveDetection>;
      };
      expect(payload.count).toBeGreaterThan(0);
      expect(payload.entries.length).toBe(payload.count);

      const ours = payload.entries.find((e) => e.ua === uniqueUa);
      expect(ours).toBeDefined();
      expect(ours?.url).toBe(uniqueUrl);
      expect(ours?.method).toBe('GET');
      expect(ours?.host).toBe('localhost');
      expect(ours?.remote).toBe('127.0.0.1');

      // The benign reader request has UA `BenignReader/1.0` — no signals fire.
      expect(payload.detection).toEqual({
        app: null,
        signals_fired: [],
      });
    } finally {
      await cleanup();
    }
  });

  test('refuses non-loopback peer with 403 loopback-required', async () => {
    const { ext, cleanup } = setup();
    try {
      const req = makeGetReq('/api/__embed-detect', { remoteAddress: '192.168.1.10' });
      const { res, captured } = makeRes();
      await dispatch(ext, req, res);
      expect(captured.status).toBe(403);
      const body = JSON.parse(captured.body) as { type: string };
      expect(body.type).toBe('urn:ok:error:loopback-required');
    } finally {
      await cleanup();
    }
  });

  test('refuses non-allowlisted Host header with 403 host-not-allowed', async () => {
    const { ext, cleanup } = setup();
    try {
      const req = makeGetReq('/api/__embed-detect', { host: 'evil.example.com' });
      const { res, captured } = makeRes();
      await dispatch(ext, req, res);
      expect(captured.status).toBe(403);
      const body = JSON.parse(captured.body) as { type: string };
      expect(body.type).toBe('urn:ok:error:host-not-allowed');
    } finally {
      await cleanup();
    }
  });

  test('rejects non-GET methods with 405', async () => {
    const { ext, cleanup } = setup();
    try {
      const req = makeGetReq('/api/__embed-detect');
      req.method = 'POST';
      const { res, captured } = makeRes();
      await dispatch(ext, req, res);
      expect(captured.status).toBe(405);
      const body = JSON.parse(captured.body) as { type: string };
      expect(body.type).toBe('urn:ok:error:method-not-allowed');
    } finally {
      await cleanup();
    }
  });

  test('derives detection from most-recent entry when Cursor hits the probe', async () => {
    const { ext, cleanup } = setup();
    try {
      // Hit the probe endpoint itself with a Cursor-shaped UA + referer.
      // The probe captures THIS request as the newest entry, so its fields
      // drive the eager classification.
      const req = makeGetReq('/api/__embed-detect', {
        userAgent: 'Mozilla/5.0 Cursor/1.5.7 Electron/30.0.1',
        referer: 'http://localhost:39847/?strategy=C_iframe',
      });
      const { res, captured } = makeRes();
      await dispatch(ext, req, res);
      expect(captured.status).toBe(200);
      const payload = JSON.parse(captured.body) as {
        detection: ReturnType<typeof deriveDetection>;
      };
      expect(payload.detection.app).toBe('cursor');
      expect(payload.detection.signals_fired).toEqual(
        expect.arrayContaining(['cursor_ua_regex', 'cursor_referer_strategy_iframe']),
      );
    } finally {
      await cleanup();
    }
  });
});
