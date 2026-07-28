/**
 * Per-handler narrow-integration smoke test for `handleMetricsAgentEffects`.
 *
 * Asserts the canonical RFC 9457 wire shape for
 * `GET /api/metrics/agent-effects`. This handler shares the same
 * auth-before-method-dispatch ordering as `handleMetricsAgentPresence`
 * (loopback gate → host-allowlist gate → method check) so a bad Host never
 * leaks "verb the endpoint expects" via 405.
 *
 * Coverage:
 *   - happy path: 200 + `application/json` + body parses against
 *     `MetricsAgentEffectsSuccessSchema`, no `ok` discriminator.
 *   - populated path: an agent write is captured into the doc's ring buffer
 *     and surfaces as a summarized per-doc block (character counts only —
 *     never the raw delta text).
 *   - DNS-rebinding Host → 403 `urn:ok:error:host-not-allowed` (must
 *     emit BEFORE the method check).
 *   - method-not-allowed on POST → 405 `urn:ok:error:method-not-allowed`
 *     with `Allow: GET`.
 */

import {
  MetricsAgentEffectsSuccessSchema,
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

describe('metrics-agent-effects envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/agent-effects`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    expect(MetricsAgentEffectsSuccessSchema.safeParse(body).success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('an agent write surfaces as a summarized per-doc block (no raw delta text)', async () => {
    const docName = `agent-effects-populated-${crypto.randomUUID().slice(0, 8)}`;
    const written = '# Agent effects probe\n';
    const writeRes = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: written, position: 'replace', docName }),
    });
    expect(writeRes.status).toBe(200);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/agent-effects`);
    expect(res.status).toBe(200);
    const parsed = MetricsAgentEffectsSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const block = parsed.data.effects.find((b) => b['doc.name'] === docName);
    expect(block).toBeDefined();
    expect(block?.entries.length).toBeGreaterThan(0);
    const entry = block?.entries[0];
    expect(entry?.insertedChars).toBeGreaterThan(0);
    // Summaries only: the response must never carry the written text.
    expect(JSON.stringify(parsed.data)).not.toContain('Agent effects probe');
  });

  test('DNS-rebinding Host emits 403 urn:ok:error:host-not-allowed BEFORE method check', async () => {
    const res = await fetchWithHostHeader(
      `http://127.0.0.1:${server.port}/api/metrics/agent-effects`,
      'evil.example.com',
      { method: 'POST' },
    );
    // Auth-before-method-dispatch ordering: bad Host → 403, NOT 405.
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('method-not-allowed on POST (with valid Host) emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/agent-effects`, {
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
