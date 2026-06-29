import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  HistoryVersionSuccessSchema,
  ProblemDetailsSchema,
  SaveVersionSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, pollDiskContentStable, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('history-version envelope (RFC 9457)', () => {
  test('happy path emits flat history-version body parseable as HistoryVersionSuccessSchema', async () => {
    const docName = `history-version-happy-${crypto.randomUUID().slice(0, 8)}`;
    await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: '# Hello\n', position: 'replace' }),
    });
    await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (c) => c.includes('# Hello'),
      { timeoutMs: 5000, settleMs: 100 },
    );
    const saveRes = await fetch(`http://127.0.0.1:${server.port}/api/save-version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName }),
    });
    expect(saveRes.status).toBe(200);
    const saveBody = SaveVersionSuccessSchema.parse(await saveRes.json());
    const refMatch = saveBody.checkpointRef.match(/([0-9a-f]{40})$/);
    expect(refMatch).not.toBeNull();
    const sha = refMatch?.[1] ?? '';
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/history/${sha}?docName=${encodeURIComponent(docName)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    const parsed = HistoryVersionSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sha).toBe(sha);
      expect(typeof parsed.data.content).toBe('string');
      expect(typeof parsed.data.timestamp).toBe('string');
      expect(typeof parsed.data.author).toBe('string');
    }
  });

  test('invalid SHA emits problem+json invalid-request', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/history/not-a-sha?docName=test-doc`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('valid SHA but missing commit emits problem+json doc-not-found', async () => {
    const fakeSha = '0123456789abcdef0123456789abcdef01234567';
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/history/${fakeSha}?docName=test-doc`,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:doc-not-found');
      expect(parsed.data.status).toBe(404);
    }
  });

  test('method-not-allowed on POST emits problem+json with Allow: GET', async () => {
    const fakeSha = '0123456789abcdef0123456789abcdef01234567';
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/history/${fakeSha}?docName=test-doc`,
      { method: 'POST' },
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('allow')).toBe('GET');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
