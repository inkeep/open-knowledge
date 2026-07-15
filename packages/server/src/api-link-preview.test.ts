import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiExtension } from './api-extension.ts';
import type { GuardRejectReason } from './link-preview/guarded-fetch.ts';
import type { GuardedFetch } from './link-preview/metadata.ts';
import { PinoLogger } from './logger.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

const PREVIEW_URL = '/api/link-preview';
// 8-byte PNG signature (+ padding) — enough for the metadata layer's magic-byte
// sniff to recognize the favicon bytes as a real image.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

/**
 * Stand-in for the SSRF-guarded chokepoint. It does NOT re-implement the guard —
 * it is the network boundary the route calls, so the route → parse → cache →
 * envelope wiring can be exercised without egress. The favicon fetch is
 * identified by its image content-type predicate. `calls` records every fetch so
 * a test can prove "no fetch on rejection" and "one fetch across two hovers".
 */
function makeFakeFetch(config: {
  html?: string;
  reason?: GuardRejectReason;
  faviconBytes?: Uint8Array;
}): { impl: GuardedFetch; calls: string[] } {
  const calls: string[] = [];
  const impl: GuardedFetch = async (url, options) => {
    calls.push(url);
    const isFaviconFetch = options?.allowContentType?.('image/png') === true;
    if (isFaviconFetch) {
      if (!config.faviconBytes) return { ok: false, reason: 'non-html' };
      return { ok: true, body: config.faviconBytes, contentType: 'image/png', finalUrl: url };
    }
    if (config.reason) return { ok: false, reason: config.reason };
    return {
      ok: true,
      body: new TextEncoder().encode(config.html ?? ''),
      contentType: 'text/html',
      finalUrl: url,
    };
  };
  return { impl, calls };
}

interface Harness {
  baseURL: string;
  close: () => Promise<void>;
}

/**
 * `getLinkPreviewsEnabled` defaults to `() => true` so the pre-existing gate /
 * outcome tests exercise the enabled path; pass `null` to OMIT the option
 * entirely (the fail-closed case), or a custom getter for the enforcement
 * tests.
 */
async function startHarness(
  contentDir: string,
  linkPreviewFetch?: GuardedFetch,
  getLinkPreviewsEnabled: (() => boolean) | null = () => true,
): Promise<Harness> {
  const ext = createApiExtension({
    hocuspocus: {} as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    serverInstanceId: 'test-server',
    getFileIndex: () => new Map(),
    linkPreviewFetch,
    ...(getLinkPreviewsEnabled === null ? {} : { getLinkPreviewsEnabled }),
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

interface PostOptions {
  origin?: string | null;
  contentType?: string | null;
  method?: string;
  body?: string;
}

function postPreview(baseURL: string, options: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.origin != null) headers.Origin = options.origin;
  if (options.contentType != null) headers['Content-Type'] = options.contentType;
  return fetch(`${baseURL}${PREVIEW_URL}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.method === 'GET' ? undefined : (options.body ?? '{}'),
  });
}

/** Per-describe scaffolding: a tmp content dir plus a single harness the test
 *  opens via `open()` and `afterEach` tears down. */
function useHarness(): {
  open: (
    linkPreviewFetch?: GuardedFetch,
    getLinkPreviewsEnabled?: (() => boolean) | null,
  ) => Promise<Harness>;
} {
  let tmpDir = '';
  let contentDir = '';
  let opened: Harness | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-link-preview-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
  });

  afterEach(async () => {
    if (opened) {
      await opened.close();
      opened = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  return {
    open: async (
      linkPreviewFetch?: GuardedFetch,
      getLinkPreviewsEnabled: (() => boolean) | null = () => true,
    ) => {
      opened = await startHarness(contentDir, linkPreviewFetch, getLinkPreviewsEnabled);
      return opened;
    },
  };
}

const jsonPost = (url: string) => ({
  contentType: 'application/json',
  body: JSON.stringify({ url }),
});

describe('POST /api/link-preview anti-proxy gate', () => {
  const rig = useHarness();

  test('rejects a cross-origin Origin without fetching', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl);
    const res = await postPreview(harness.baseURL, {
      origin: 'https://evil.example',
      ...jsonPost('https://example.com'),
    });
    expect(res.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  test('rejects Origin: null (sandboxed iframe) without fetching', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl);
    const res = await postPreview(harness.baseURL, {
      origin: 'null',
      ...jsonPost('https://example.com'),
    });
    expect(res.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  test('rejects an absent Origin without fetching', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl);
    const res = await postPreview(harness.baseURL, {
      origin: null,
      ...jsonPost('https://example.com'),
    });
    expect(res.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  test('rejects a GET without fetching', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl);
    const res = await postPreview(harness.baseURL, { method: 'GET', origin: harness.baseURL });
    expect(res.status).toBe(405);
    expect(fake.calls).toHaveLength(0);
  });

  test('rejects a non-JSON content type without fetching', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl);
    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      contentType: 'text/plain',
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  test('rejects a body missing the url field before fetching', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl);
    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('POST /api/link-preview preview outcomes', () => {
  const rig = useHarness();

  test('returns card metadata for a well-formed same-origin POST', async () => {
    const fake = makeFakeFetch({
      html: '<head><title>Example Domain</title><meta name="description" content="A demo page"></head>',
    });
    const harness = await rig.open(fake.impl);

    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('https://example.com/page'),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; metadata?: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.metadata?.domain).toBe('example.com');
    expect(body.metadata?.title).toBe('Example Domain');
    expect(body.metadata?.description).toBe('A demo page');
    expect(fake.calls).toContain('https://example.com/page');
  });

  test('carries a validated favicon through as a data URI', async () => {
    const fake = makeFakeFetch({
      html: '<title>Iconic</title><link rel="icon" href="/favicon.ico">',
      faviconBytes: PNG_BYTES,
    });
    const harness = await rig.open(fake.impl);

    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('https://example.com/'),
    });

    const body = (await res.json()) as { ok: boolean; metadata?: { faviconDataUri?: string } };
    expect(body.ok).toBe(true);
    expect(body.metadata?.faviconDataUri).toStartWith('data:image/png;base64,');
  });

  test('a guard rejection crosses the wire with the single coarse reason', async () => {
    // The guard produced the granular 'private-ip' (kept in logs + cache), but
    // the response must not distinguish it from any other rejection — a
    // loopback caller could otherwise enumerate internal names by pairing
    // chosen hostnames with reasons.
    const fake = makeFakeFetch({ reason: 'private-ip' });
    const harness = await rig.open(fake.impl);

    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('https://intranet.example'),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'blocked' });
  });

  test('distinct guard reasons are indistinguishable on the wire', async () => {
    const dnsFake = makeFakeFetch({ reason: 'dns-failure' });
    const harness = await rig.open(dnsFake.impl);
    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('https://does-not-resolve.example'),
    });
    expect(await res.json()).toEqual({ ok: false, reason: 'blocked' });
  });

  test('serves the cache-hit fast path without re-fetching', async () => {
    const fake = makeFakeFetch({ html: '<title>Cached</title>' });
    const harness = await rig.open(fake.impl);
    const url = 'https://example.com/cached';

    const first = await postPreview(harness.baseURL, { origin: harness.baseURL, ...jsonPost(url) });
    const second = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost(url),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);
    // The page URL was fetched exactly once; the second hover was served warm.
    expect(fake.calls.filter((u) => u === url)).toHaveLength(1);
  });
});

describe('POST /api/link-preview server-side linkPreviews.enabled enforcement', () => {
  const rig = useHarness();

  test('previews disabled: non-ok envelope, zero outbound fetches', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl, () => false);
    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('https://example.com/'),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'disabled' });
    expect(fake.calls).toHaveLength(0);
  });

  test('getter omitted entirely: fail-closed, zero outbound fetches', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl, null);
    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('https://example.com/'),
    });
    expect(await res.json()).toEqual({ ok: false, reason: 'disabled' });
    expect(fake.calls).toHaveLength(0);
  });

  test('a throwing config read is fail-closed, zero outbound fetches', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl, () => {
      throw new Error('config read failed');
    });
    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('https://example.com/'),
    });
    expect(await res.json()).toEqual({ ok: false, reason: 'disabled' });
    expect(fake.calls).toHaveLength(0);
  });

  test('the disabled short-circuit never poisons the cache: enabling serves a fresh preview', async () => {
    const fake = makeFakeFetch({ html: '<title>Fresh</title>' });
    let enabled = false;
    // Fresh-read contract: the getter is consulted per request, so flipping the
    // flag mid-harness models a runtime Settings toggle without a restart.
    const harness = await rig.open(fake.impl, () => enabled);
    const url = 'https://example.com/toggled';

    const off = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost(url),
    });
    expect(await off.json()).toEqual({ ok: false, reason: 'disabled' });
    expect(fake.calls).toHaveLength(0);

    enabled = true;
    const on = await postPreview(harness.baseURL, { origin: harness.baseURL, ...jsonPost(url) });
    const body = (await on.json()) as { ok: boolean; metadata?: { title?: string } };
    expect(body.ok).toBe(true);
    expect(body.metadata?.title).toBe('Fresh');
  });
});

describe('POST /api/link-preview real SSRF chokepoint', () => {
  // No injected fetch: these exercise the production guardedFetch end-to-end
  // through the route, proving the real chokepoint is wired in.
  const rig = useHarness();

  test('rejects a private-IP target with a structured failure', async () => {
    const harness = await rig.open();
    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('http://127.0.0.1:9'),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'blocked' });
  });

  test('treats an empty url as a structured failure', async () => {
    const harness = await rig.open();
    const res = await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost(''),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(typeof body.reason).toBe('string');
  });
});

describe('POST /api/link-preview outcome instrumentation', () => {
  const rig = useHarness();

  // Spy at the prototype: api-extension.ts holds a module-level
  // `getLogger('api')` binding, and sibling test files' configure()/reset()
  // calls clear the factory's instance cache, so an instance-level spy taken
  // here could wrap a DIFFERENT logger than the one the route actually uses.
  let debugSpy: Mock<PinoLogger['debug']>;

  beforeEach(() => {
    debugSpy = spyOn(PinoLogger.prototype, 'debug');
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  /** The `outcome` categories logged by the route, in emission order. */
  function loggedOutcomes(): unknown[] {
    return debugSpy.mock.calls
      .filter(([, message]) => message === '[link-preview] request outcome')
      .map(([data]) => (data as { outcome?: unknown }).outcome);
  }

  test('the disabled short-circuit logs its outcome category', async () => {
    const fake = makeFakeFetch({ html: '<title>never</title>' });
    const harness = await rig.open(fake.impl, () => false);

    await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('https://example.com/'),
    });

    expect(loggedOutcomes()).toEqual(['disabled']);
  });

  test('a fresh fetch logs fetched-ok and the warm re-hover logs cache-hit', async () => {
    const fake = makeFakeFetch({ html: '<title>Logged</title>' });
    const harness = await rig.open(fake.impl);
    const url = 'https://example.com/logged';

    await postPreview(harness.baseURL, { origin: harness.baseURL, ...jsonPost(url) });
    await postPreview(harness.baseURL, { origin: harness.baseURL, ...jsonPost(url) });

    expect(loggedOutcomes()).toEqual(['fetched-ok', 'cache-hit']);
  });

  test('a guard rejection logs fallback, and the record is the category alone', async () => {
    const fake = makeFakeFetch({ reason: 'private-ip' });
    const harness = await rig.open(fake.impl);

    await postPreview(harness.baseURL, {
      origin: harness.baseURL,
      ...jsonPost('https://intranet.example/secret-path'),
    });

    expect(loggedOutcomes()).toEqual(['fallback']);
    // Hygiene invariant: the outcome record carries the category and nothing
    // else. The URL / hostname / resolved IP must never reach these lines.
    const outcomeCalls = debugSpy.mock.calls.filter(
      ([, message]) => message === '[link-preview] request outcome',
    );
    for (const [data] of outcomeCalls) {
      expect(Object.keys(data as Record<string, unknown>)).toEqual(['outcome']);
    }
  });
});
