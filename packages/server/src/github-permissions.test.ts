import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  type DataPoint,
  type Histogram as HistogramData,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  __resetGithubPermissionsTelemetryForTests,
  checkPushPermission,
  type DetectGhFn,
  type FetchFn,
  type ProbeTokenStore,
  type PushPermission,
} from './github-permissions.ts';


function mockFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetch: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: FetchFn = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fetch: fn, calls };
}

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ghAvailable(token = 'ghs_tier_a_token'): DetectGhFn {
  return () => ({ available: true, token });
}

function ghUnavailable(): DetectGhFn {
  return () => ({ available: false });
}

function fakeStore(token: string | null): { store: ProbeTokenStore; hosts: string[] } {
  const hosts: string[] = [];
  const store: ProbeTokenStore = {
    async get(host) {
      hosts.push(host);
      return token === null ? null : { token };
    },
  };
  return { store, hosts };
}

function authHeader(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}


describe('checkPushPermission — classification', () => {
  const cases: Array<{
    name: string;
    status: number;
    body?: unknown;
    withToken: boolean;
    expected: PushPermission;
  }> = [
    {
      name: '200 + permissions.push:true → allowed',
      status: 200,
      body: { permissions: { push: true } },
      withToken: true,
      expected: { kind: 'allowed' },
    },
    {
      name: '200 + permissions.push:false → denied/no-collaborator',
      status: 200,
      body: { permissions: { push: false } },
      withToken: true,
      expected: { kind: 'denied', reason: 'no-collaborator' },
    },
    {
      name: '200 without permissions field (authed, schema drift) → unknown/malformed-response',
      status: 200,
      body: { full_name: 'inkeep/open-knowledge' },
      withToken: true,
      expected: { kind: 'unknown', error: 'malformed-response' },
    },
    {
      name: '200 + permissions.push of wrong type → unknown/malformed-response',
      status: 200,
      body: { permissions: { push: 'yes' } },
      withToken: true,
      expected: { kind: 'unknown', error: 'malformed-response' },
    },
    {
      name: '404 with auth → denied/private-no-access',
      status: 404,
      withToken: true,
      expected: { kind: 'denied', reason: 'private-no-access' },
    },
    {
      name: '401 → unknown/token-invalid',
      status: 401,
      withToken: true,
      expected: { kind: 'unknown', error: 'token-invalid' },
    },
    {
      name: '403 without ratelimit-remaining → unknown/token-invalid (e.g. SAML SSO unauthorized)',
      status: 403,
      withToken: true,
      expected: { kind: 'unknown', error: 'token-invalid' },
    },
    {
      name: '429 → unknown/rate-limit',
      status: 429,
      withToken: true,
      expected: { kind: 'unknown', error: 'rate-limit' },
    },
    {
      name: '500 (unexpected status) → unknown/malformed-response',
      status: 500,
      withToken: true,
      expected: { kind: 'unknown', error: 'malformed-response' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const { fetch } = mockFetch(() => jsonResponse(c.status, c.body));
      const result = await checkPushPermission({
        owner: 'inkeep',
        repo: 'open-knowledge',
        detectGh: c.withToken ? ghAvailable() : ghUnavailable(),
        _fetchFn: fetch,
      });
      expect(result).toEqual(c.expected);
    });
  }

  test('403 with x-ratelimit-remaining: 0 → unknown/rate-limit (primary rate-limit path)', async () => {
    const { fetch } = mockFetch(
      () =>
        new Response('', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'content-type': 'application/json' },
        }),
    );
    const result = await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    expect(result).toEqual({ kind: 'unknown', error: 'rate-limit' });
  });

  test('200 with a non-JSON body → unknown/malformed-response', async () => {
    const { fetch } = mockFetch(() => new Response('<!doctype html>', { status: 200 }));
    const result = await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    expect(result).toEqual({ kind: 'unknown', error: 'malformed-response' });
  });

  test('fetch rejection (network/DNS/TLS failure) → unknown/network', async () => {
    const fetchFn: FetchFn = () => Promise.reject(new Error('ENETUNREACH'));
    const result = await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetchFn,
    });
    expect(result).toEqual({ kind: 'unknown', error: 'network' });
  });

  test('an AbortError-shaped rejection without the timer firing → unknown/network', async () => {
    const fetchFn: FetchFn = (_input, init) =>
      Promise.reject(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          signal: init?.signal,
        }),
      );
    const result = await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetchFn,
    });
    expect(result).toEqual({ kind: 'unknown', error: 'network' });
  });

  test('probe-timeout firing (signal.aborted === true) → unknown/timeout', async () => {
    const fetchFn: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) {
          reject(new Error('no signal'));
          return;
        }
        sig.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    const result = await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetchFn,
      _timeoutMs: 20,
    });
    expect(result).toEqual({ kind: 'unknown', error: 'timeout' });
  });
});


describe('checkPushPermission — token resolution', () => {
  test('Tier A: gh token is used and the credential store is not consulted', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { permissions: { push: true } }));
    const { store, hosts } = fakeStore('gho_tier_b_token');
    await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable('ghs_tier_a_token'),
      tokenStore: store,
      _fetchFn: fetch,
    });
    expect(authHeader(calls[0]?.init)).toBe('Bearer ghs_tier_a_token');
    expect(hosts).toEqual([]); // store untouched when gh wins
  });

  test('Tier B/C: falls back to the stored token when gh is unavailable', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { permissions: { push: false } }));
    const { store, hosts } = fakeStore('gho_tier_b_token');
    await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      host: 'github.com',
      detectGh: ghUnavailable(),
      tokenStore: store,
      _fetchFn: fetch,
    });
    expect(authHeader(calls[0]?.init)).toBe('Bearer gho_tier_b_token');
    expect(hosts).toEqual(['github.com']);
  });

  test('anonymous: no credential → denied/no-collaborator with NO HTTP call (short-circuit)', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, {}));
    const { store } = fakeStore(null);
    const result = await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghUnavailable(),
      tokenStore: store,
      _fetchFn: fetch,
    });
    expect(result).toEqual({ kind: 'denied', reason: 'no-collaborator' });
    expect(calls).toHaveLength(0); // no credential ⇒ no push ⇒ no probe
  });

  test('anonymous: omitting both detectGh and tokenStore short-circuits without a request', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, {}));
    const result = await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      _fetchFn: fetch,
    });
    expect(result).toEqual({ kind: 'denied', reason: 'no-collaborator' });
    expect(calls).toHaveLength(0);
  });

  test('gh detection is scoped to the requested host', async () => {
    const seenHosts: Array<string | undefined> = [];
    const detectGh: DetectGhFn = (host) => {
      seenHosts.push(host);
      return { available: false };
    };
    const { fetch } = mockFetch(() => jsonResponse(200, {}));
    await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      host: 'github.example.com',
      detectGh,
      _fetchFn: fetch,
    });
    expect(seenHosts).toEqual(['github.example.com']);
  });
});


describe('checkPushPermission — request shape', () => {
  test('hits api.github.com/repos/OWNER/REPO with the GitHub user-agent + accept', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { permissions: { push: true } }));
    await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/inkeep/open-knowledge');
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.['User-Agent']).toBe('open-knowledge-server');
    expect(headers?.Accept).toBe('application/vnd.github+json');
  });

  test('GHES host routes through /api/v3 base', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { permissions: { push: true } }));
    await checkPushPermission({
      owner: 'acme',
      repo: 'docs',
      host: 'github.example.com',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    expect(calls[0]?.url).toBe('https://github.example.com/api/v3/repos/acme/docs');
  });

  test('percent-encodes path segments to defeat URL injection', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { permissions: { push: true } }));
    await checkPushPermission({
      owner: 'owner/../escape',
      repo: 'name',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    expect(calls[0]?.url).toBe('https://api.github.com/repos/owner%2F..%2Fescape/name');
  });

  test('passes an AbortSignal so the timeout stays wired up', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { permissions: { push: true } }));
    await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('makes exactly one HTTP call per probe', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { permissions: { push: true } }));
    await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    expect(calls).toHaveLength(1);
  });
});


interface MetricHarness {
  exporter: InMemoryMetricExporter;
  flush: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function setupMetricHarness(): MetricHarness {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const meterProvider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(meterProvider);
  __resetGithubPermissionsTelemetryForTests();
  return {
    exporter,
    async flush() {
      await reader.forceFlush();
    },
    async cleanup() {
      await meterProvider.shutdown();
      metrics.disable();
      __resetGithubPermissionsTelemetryForTests();
    },
  };
}

function dataPoints(harness: MetricHarness, name: string): Array<DataPoint<unknown>> {
  const out: Array<DataPoint<unknown>> = [];
  for (const rm of harness.exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name !== name) continue;
        out.push(...(metric.dataPoints as Array<DataPoint<unknown>>));
      }
    }
  }
  return out;
}

describe('checkPushPermission — telemetry', () => {
  let harness: MetricHarness;

  beforeEach(() => {
    harness = setupMetricHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test('records outcome counter + duration histogram for an allowed probe', async () => {
    const { fetch } = mockFetch(() => jsonResponse(200, { permissions: { push: true } }));
    await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    await harness.flush();

    const counter = dataPoints(harness, 'ok.permissions.probe.outcome_total');
    expect(counter).toHaveLength(1);
    expect(counter[0]?.value).toBe(1);
    expect(counter[0]?.attributes).toEqual({
      outcome: 'allowed',
      denied_reason: 'none',
      error_class: 'none',
    });

    const hist = dataPoints(harness, 'ok.permissions.probe.duration_ms');
    expect(hist).toHaveLength(1);
    expect((hist[0]?.value as HistogramData).count).toBe(1);
  });

  test('denied probe records its reason; error_class stays none', async () => {
    const { fetch } = mockFetch(() => jsonResponse(200, { permissions: { push: false } }));
    await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    await harness.flush();

    const counter = dataPoints(harness, 'ok.permissions.probe.outcome_total');
    expect(counter[0]?.attributes).toEqual({
      outcome: 'denied',
      denied_reason: 'no-collaborator',
      error_class: 'none',
    });
  });

  test('unknown probe records its error_class; denied_reason stays none', async () => {
    const { fetch } = mockFetch(() => jsonResponse(401));
    await checkPushPermission({
      owner: 'inkeep',
      repo: 'open-knowledge',
      detectGh: ghAvailable(),
      _fetchFn: fetch,
    });
    await harness.flush();

    const counter = dataPoints(harness, 'ok.permissions.probe.outcome_total');
    expect(counter[0]?.attributes).toEqual({
      outcome: 'unknown',
      denied_reason: 'none',
      error_class: 'token-invalid',
    });
  });

  test('attributes are bounded — never the repo identifier or URL', async () => {
    const { fetch } = mockFetch(() => jsonResponse(404));
    await checkPushPermission({
      owner: 'secret-owner-abc',
      repo: 'secret-repo-xyz',
      detectGh: ghAvailable('secret-token-123'),
      _fetchFn: fetch,
    });
    await harness.flush();

    const points = [
      ...dataPoints(harness, 'ok.permissions.probe.outcome_total'),
      ...dataPoints(harness, 'ok.permissions.probe.duration_ms'),
    ];
    expect(points.length).toBeGreaterThan(0);
    const allowedCounterKeys = ['denied_reason', 'error_class', 'outcome'];
    for (const p of points) {
      const keys = Object.keys(p.attributes).sort();
      expect(keys.every((k) => allowedCounterKeys.includes(k))).toBe(true);
      const serialized = JSON.stringify(p.attributes);
      expect(serialized).not.toContain('secret-owner-abc');
      expect(serialized).not.toContain('secret-repo-xyz');
      expect(serialized).not.toContain('secret-token-123');
    }
  });
});
