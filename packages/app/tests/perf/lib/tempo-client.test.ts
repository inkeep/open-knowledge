/**
 * Tests for the Tempo HTTP API query helper.
 *
 * The helper joins per-cycle OTel spans (frontend ok.cold-mount tree + 4
 * children, server sync.handshake, persistence.onLoadDocument) by mountId
 * attribute and returns decomposed timings.
 *
 * Mocks fetch at the boundary. The actual Tempo HTTP API is exercised
 * with the live LGTM stack running — Docker is
 * not running in this environment.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  parseTempoTimings,
  queryTempoByMountId,
  type TempoSearchOptions,
  type TempoSearchResponse,
} from './tempo-client';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function installFetchStub(handler: (input: RequestInfo | URL) => Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const DEFAULT_OPTS: TempoSearchOptions = {
  mountId: 'mid-test',
  startTimeMs: 1_700_000_000_000,
  endTimeMs: 1_700_000_001_000,
  tempoBaseUrl: 'http://localhost:3200',
};

/**
 * Build a synthetic Tempo /api/search response. Each entry in `spans`
 * becomes one span at the trace level. Each span has its name, duration,
 * and the attributes map. mountId is set on every span when provided so
 * the helper's join-by-mountId logic sees a complete cycle.
 */
function buildTempoResponse(
  spans: Array<{ name: string; durationMs: number; mountId?: string }>,
): TempoSearchResponse {
  return {
    traces: [
      {
        traceID: 'trace-1',
        spanSet: {
          spans: spans.map((s, i) => ({
            spanID: `span-${i}`,
            name: s.name,
            durationNanos: String(s.durationMs * 1_000_000),
            attributes:
              s.mountId !== undefined
                ? [{ key: 'mount.id', value: { stringValue: s.mountId } }]
                : [],
          })),
        },
      },
    ],
  };
}

describe('parseTempoTimings — pure extraction', () => {
  test('extracts all 6 timings when every span is present', () => {
    const response = buildTempoResponse([
      { name: 'ok.cold-mount', durationMs: 250, mountId: 'mid-a' },
      { name: 'ok.provider-pool.open', durationMs: 5, mountId: 'mid-a' },
      { name: 'ok.mount-promise', durationMs: 40, mountId: 'mid-a' },
      { name: 'ok.sync-promise', durationMs: 240, mountId: 'mid-a' },
      { name: 'sync.handshake', durationMs: 12, mountId: 'mid-a' },
      { name: 'persistence.onLoadDocument', durationMs: 8, mountId: 'mid-a' },
    ]);
    const result = parseTempoTimings(response, 'mid-a');
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.clientSpanTimings.coldMountMs).toBe(250);
      expect(result.clientSpanTimings.providerPoolOpenMs).toBe(5);
      expect(result.clientSpanTimings.mountPromiseMs).toBe(40);
      expect(result.clientSpanTimings.syncPromiseMs).toBe(240);
      expect(result.serverSpanTimings.syncHandshakeMs).toBe(12);
      expect(result.serverSpanTimings.persistenceLoadMs).toBe(8);
    }
  });

  test('returns empty when the response has no traces', () => {
    const result = parseTempoTimings({ traces: [] }, 'mid-a');
    expect(result.kind).toBe('empty');
  });

  test('returns correlation-missing when traces exist but none match the mountId', () => {
    const response = buildTempoResponse([
      { name: 'ok.cold-mount', durationMs: 250, mountId: 'mid-different' },
      { name: 'ok.sync-promise', durationMs: 200, mountId: 'mid-different' },
    ]);
    const result = parseTempoTimings(response, 'mid-target');
    expect(result.kind).toBe('correlation-missing');
  });

  test('returns success with null fields for spans that did not arrive', () => {
    // Partial trace — only frontend spans, server-side spans are missing
    // (e.g., OTEL_SDK_DISABLED is unset on the server). Sweep still wants
    // the client decomposition.
    const response = buildTempoResponse([
      { name: 'ok.cold-mount', durationMs: 100, mountId: 'mid-p' },
      { name: 'ok.sync-promise', durationMs: 90, mountId: 'mid-p' },
    ]);
    const result = parseTempoTimings(response, 'mid-p');
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.clientSpanTimings.coldMountMs).toBe(100);
      expect(result.clientSpanTimings.syncPromiseMs).toBe(90);
      expect(result.clientSpanTimings.mountPromiseMs).toBeNull();
      expect(result.clientSpanTimings.providerPoolOpenMs).toBeNull();
      expect(result.serverSpanTimings.syncHandshakeMs).toBeNull();
      expect(result.serverSpanTimings.persistenceLoadMs).toBeNull();
    }
  });

  test('tolerates spans across multiple traces in one response', () => {
    // BSP can flush in batches that span trace boundaries. The helper
    // collapses by mountId attribute regardless of which trace owns each
    // span.
    const response: TempoSearchResponse = {
      traces: [
        {
          traceID: 'tx',
          spanSet: {
            spans: [
              {
                spanID: 's1',
                name: 'ok.sync-promise',
                durationNanos: '100000000',
                attributes: [{ key: 'mount.id', value: { stringValue: 'mid-multi' } }],
              },
            ],
          },
        },
        {
          traceID: 'ty',
          spanSet: {
            spans: [
              {
                spanID: 's2',
                name: 'sync.handshake',
                durationNanos: '5000000',
                attributes: [{ key: 'mount.id', value: { stringValue: 'mid-multi' } }],
              },
            ],
          },
        },
      ],
    };
    const result = parseTempoTimings(response, 'mid-multi');
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.clientSpanTimings.syncPromiseMs).toBe(100);
      expect(result.serverSpanTimings.syncHandshakeMs).toBe(5);
    }
  });

  test('tolerates spans inside spanSets (plural) when Tempo returns the alternate shape', () => {
    // Tempo's response shape uses `spanSet` in some versions, `spanSets`
    // (array) in others (TraceQL grouping). The helper accepts both.
    const response: TempoSearchResponse = {
      traces: [
        {
          traceID: 'ts',
          spanSets: [
            {
              spans: [
                {
                  spanID: 'sp',
                  name: 'ok.cold-mount',
                  durationNanos: '300000000',
                  attributes: [{ key: 'mount.id', value: { stringValue: 'mid-shapes' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseTempoTimings(response, 'mid-shapes');
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.clientSpanTimings.coldMountMs).toBe(300);
    }
  });
});

describe('queryTempoByMountId — HTTP boundary', () => {
  test('returns success on a well-formed response with matching mountId', async () => {
    installFetchStub(async () =>
      jsonResponse(
        buildTempoResponse([
          { name: 'ok.cold-mount', durationMs: 250, mountId: 'mid-test' },
          { name: 'ok.sync-promise', durationMs: 240, mountId: 'mid-test' },
        ]),
      ),
    );
    const result = await queryTempoByMountId(DEFAULT_OPTS);
    expect(result.kind).toBe('success');
  });

  test('returns empty when Tempo response has no traces', async () => {
    installFetchStub(async () => jsonResponse({ traces: [] }));
    const result = await queryTempoByMountId(DEFAULT_OPTS);
    expect(result.kind).toBe('empty');
  });

  test('returns correlation-missing when response has traces but none match the mountId', async () => {
    installFetchStub(async () =>
      jsonResponse(
        buildTempoResponse([{ name: 'ok.cold-mount', durationMs: 50, mountId: 'mid-other' }]),
      ),
    );
    const result = await queryTempoByMountId(DEFAULT_OPTS);
    expect(result.kind).toBe('correlation-missing');
  });

  test('returns error on malformed JSON response', async () => {
    installFetchStub(
      async () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const result = await queryTempoByMountId(DEFAULT_OPTS);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toMatch(/parse|json/i);
    }
  });

  test('returns error on non-200 HTTP status', async () => {
    installFetchStub(
      async () =>
        new Response('upstream failed', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const result = await queryTempoByMountId(DEFAULT_OPTS);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toMatch(/503|tempo HTTP/i);
    }
  });

  test('returns error when the fetch itself throws', async () => {
    installFetchStub(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await queryTempoByMountId(DEFAULT_OPTS);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toMatch(/fetch|network/i);
    }
  });

  test('uses the configured base URL and time window in the request', async () => {
    let capturedUrl = '';
    installFetchStub(async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return jsonResponse({ traces: [] });
    });
    await queryTempoByMountId({
      ...DEFAULT_OPTS,
      tempoBaseUrl: 'http://otel.example:3200',
      startTimeMs: 1_700_000_000_000,
      endTimeMs: 1_700_000_005_000,
    });
    expect(capturedUrl).toContain('otel.example:3200');
    // Tempo expects start/end in Unix seconds (not ms). The helper must
    // convert — verifying via substring keeps the test robust against
    // query-string ordering / encoding.
    expect(capturedUrl).toContain('start=1700000000');
    expect(capturedUrl).toContain('end=1700000005');
    // mount.id is the load-bearing per-cycle correlation key. If a refactor
    // moved the filter client-side (URL stops carrying mount.id, helper
    // post-filters by attribute), URL-shape tests above would still pass
    // while every per-cycle decomposition query would return all spans in
    // the window — silently flipping a fail-loud STOP_IF: mountid-span-
    // correlation-missing path into a fail-quiet wrong-answer one. Pin the
    // mount.id query param explicitly.
    expect(capturedUrl).toContain('mount.id');
    expect(capturedUrl).toContain(DEFAULT_OPTS.mountId);
  });
});
