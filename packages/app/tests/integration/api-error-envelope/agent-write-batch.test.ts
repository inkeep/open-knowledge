/**
 * Per-handler narrow-integration smoke test for `handleAgentWriteBatch`.
 *
 * Asserts the canonical RFC 9457 wire shape:
 *   - happy path: status 200, `Content-Type: application/json`, body parses
 *     against `AgentWriteBatchSuccessSchema` (timestamp + per-entry results +
 *     written/failed counts), no `ok: true` discriminator.
 *   - missing docs / empty docs / over-cap docs / malformed per-entry docName
 *     → `urn:ok:error:invalid-request` (pre-identity body-shape rejection
 *     from `withValidation`; the whole batch rejects at the schema boundary).
 *   - reserved docname → per-entry error INSIDE a 200 body (semantic,
 *     post-identity, partial success by design).
 *   - method-not-allowed on GET.
 */

import {
  AGENT_WRITE_BATCH_MAX_DOCS,
  AgentWriteBatchSuccessSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const UUID_RE = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function postBatch(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/agent-write-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent-write-batch envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const prefix = `batch-env-${crypto.randomUUID().slice(0, 8)}`;
    const res = await postBatch({
      docs: [
        { docName: `${prefix}/one`, markdown: '# One\n', position: 'replace' },
        { docName: `${prefix}/two`, markdown: '# Two\n', position: 'replace' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = AgentWriteBatchSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timestamp.length).toBeGreaterThan(0);
      expect(parsed.data.results.length).toBe(2);
      expect(parsed.data.written).toBe(2);
      expect(parsed.data.failed).toBe(0);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('missing docs emits urn:ok:error:invalid-request', async () => {
    const res = await postBatch({});
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.status).toBe(400);
      expect(parsed.data.instance).toBeDefined();
      if (parsed.data.instance) expect(parsed.data.instance).toMatch(UUID_RE);
    }
  });

  test('empty docs array emits urn:ok:error:invalid-request', async () => {
    const res = await postBatch({ docs: [] });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
  });

  test('over-cap batch rejects wholesale with urn:ok:error:invalid-request', async () => {
    const docs = Array.from({ length: AGENT_WRITE_BATCH_MAX_DOCS + 1 }, (_, i) => ({
      docName: `batch-cap/doc-${i}`,
      markdown: '# Over cap\n',
      position: 'replace',
    }));
    const res = await postBatch({ docs });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.status).toBe(400);
    }
  });

  test('malformed per-entry docName rejects the whole batch as invalid-request', async () => {
    const res = await postBatch({
      docs: [
        { docName: 'batch-shape/fine', markdown: '# Fine\n', position: 'replace' },
        { docName: '../escape', markdown: '# Nope\n', position: 'replace' },
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
  });

  test('reserved docname is a per-entry error inside a 200 body', async () => {
    const prefix = `batch-env-reserved-${crypto.randomUUID().slice(0, 8)}`;
    const res = await postBatch({
      docs: [
        { docName: `${prefix}/fine`, markdown: '# Fine\n', position: 'replace' },
        { docName: '__system__', markdown: '# Nope\n', position: 'replace' },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = AgentWriteBatchSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.written).toBe(1);
      expect(parsed.data.failed).toBe(1);
      const failedEntry = parsed.data.results[1];
      expect(failedEntry.status).toBe('error');
      if (failedEntry.status === 'error') {
        expect(failedEntry.error.type).toBe('urn:ok:error:reserved-doc-name');
      }
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-batch`, {
      method: 'GET',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
