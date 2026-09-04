import { CommentCountsSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

describe('comment-counts envelope (RFC 9457)', () => {
  test('docNames mode answers for every doc asked about', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/comment-counts?docNames=alpha,beta`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = CommentCountsSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.counts).toEqual({ alpha: 0, beta: 0 });
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('prefix mode is sparse — a clean subtree returns no rows', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/comment-counts?prefix=docs`);
    expect(res.status).toBe(200);

    const parsed = CommentCountsSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.counts).toEqual({});
  });

  test('neither param emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/comment-counts`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.title).toContain('docNames');
    }
  });

  test('a malformed prefix is rejected, not silently widened', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/comment-counts?prefix=${encodeURIComponent('../escape')}`,
    );
    expect(res.status).toBe(400);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.title).toContain('prefix');
    }
  });

  test('a real comment shows up in both modes', async () => {
    const docName = 'rollout-notes';
    const created = await fetch(`http://127.0.0.1:${server.port}/api/create-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `${docName}.md` }),
    });
    expect(created.status).toBe(200);

    await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: 'Ship with minimal downtime.\n',
        position: 'replace',
      }),
    });

    const posted = await fetch(`http://127.0.0.1:${server.port}/api/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, quote: 'minimal downtime', body: 'still accurate?' }),
    });
    expect(posted.status).toBe(201);

    const exact = await fetch(
      `http://127.0.0.1:${server.port}/api/comment-counts?docNames=${docName}`,
    );
    expect(((await exact.json()) as { counts: Record<string, number> }).counts[docName]).toBe(1);

    const rollup = await fetch(`http://127.0.0.1:${server.port}/api/comment-counts?prefix=`);
    expect(((await rollup.json()) as { counts: Record<string, number> }).counts[docName]).toBe(1);
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/comment-counts`, {
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
