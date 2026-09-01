import {
  MetricsWatcherRecentSuccessSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { fetchWithHostHeader } from '../host-header-request.test-helper';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('metrics-watcher-recent envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json and normalized paths', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/watcher-recent`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = MetricsWatcherRecentSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
    if (!parsed.success) return;
    for (const decision of parsed.data.decisions) {
      expect(decision['doc.name'].startsWith('/')).toBe(false);
    }
  });

  test('DNS-rebinding Host emits 403 urn:ok:error:host-not-allowed BEFORE method check', async () => {
    const res = await fetchWithHostHeader(
      `http://127.0.0.1:${server.port}/api/metrics/watcher-recent`,
      'evil.example.com',
      { method: 'POST' },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('method-not-allowed on POST (with valid Host) emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/watcher-recent`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
