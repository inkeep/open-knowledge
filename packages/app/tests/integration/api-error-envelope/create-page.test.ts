import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CreatePageSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

async function postCreate(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('create-page envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const path = `create-page-${crypto.randomUUID().slice(0, 8)}.md`;
    const res = await postCreate({ path });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = CreatePageSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.docName).toBe(path.replace(/\.md$/, ''));
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('missing path emits urn:ok:error:invalid-request', async () => {
    const res = await postCreate({});
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      if (parsed.data.instance) expect(parsed.data.instance).toMatch(UUID_RE);
    }
  });

  test('unsupported extension emits urn:ok:error:invalid-request', async () => {
    const res = await postCreate({ path: 'no-ext.txt' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('reserved docname emits urn:ok:error:reserved-doc-name', async () => {
    const res = await postCreate({ path: '__system__.md' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:reserved-doc-name');
    }
  });

  test('rejects a .ok/skills/** target and writes nothing', async () => {
    const relPath = 'skills/phantom-from-create-page/SKILL.md';
    const res = await postCreate({ path: `.ok/${relPath}` });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:reserved-doc-name');
    }
    expect(existsSync(join(server.contentDir, '.ok', relPath))).toBe(false);
  });

  test('rejects a bare .ok/-rooted target and writes nothing', async () => {
    const res = await postCreate({ path: '.ok/local/sneaky.md' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:reserved-doc-name');
    }
    expect(existsSync(join(server.contentDir, '.ok', 'local', 'sneaky.md'))).toBe(false);
  });

  test('path traversal emits urn:ok:error:path-escape', async () => {
    const res = await postCreate({ path: '../escape.md' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:path-escape');
    }
  });

  test('duplicate path emits urn:ok:error:doc-already-exists', async () => {
    const path = `dup-${crypto.randomUUID().slice(0, 8)}.md`;
    const first = await postCreate({ path });
    expect(first.status).toBe(200);

    const second = await postCreate({ path });
    expect(second.status).toBe(409);
    expect(second.headers.get('content-type')).toBe('application/problem+json');

    const body = await second.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:doc-already-exists');
      expect(parsed.data.status).toBe(409);
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/create-page`, { method: 'GET' });
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
