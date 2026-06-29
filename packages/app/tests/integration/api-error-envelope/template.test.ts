import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ProblemDetailsSchema,
  TemplateDeleteSuccessSchema,
  TemplatePutSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('template envelope (RFC 9457)', () => {
  test('GET on missing template emits 404 + template-not-found', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/template?name=nonexistent&folder=`,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:template-not-found');
      expect(parsed.data.status).toBe(404);
    }
  });

  test('PUT happy path emits flat success body with path/created/warnings', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: '',
        name: 'mytmpl',
        body: '# Hello',
        frontmatter: { title: 'My Template' },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = TemplatePutSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.created).toBe(true);
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('PUT with missing title emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: '', name: 'untitled', body: '' }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('PUT with stale `target` body field is rejected by .strict() schema', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: '',
        name: 'stale',
        target: 'user',
        frontmatter: { title: 'x' },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.detail).toContain('target');
    }
  });

  test('DELETE happy path emits flat success body', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template?name=mytmpl&folder=`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = TemplateDeleteSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('GET with legacy `?target=user` query is silently ignored — serves project tier', async () => {
    const put = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: '',
        name: 'legacy-get',
        body: '# Hello',
        frontmatter: { title: 'Legacy Get' },
      }),
    });
    expect(put.status).toBe(200);

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/template?name=legacy-get&folder=&target=user`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: { scope: string } };
    expect(body.template.scope).toBe('local');
  });

  test('DELETE with legacy `?target=user` query is silently ignored — deletes project tier', async () => {
    const put = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: '',
        name: 'legacy-del',
        body: '# Hello',
        frontmatter: { title: 'Legacy Del' },
      }),
    });
    expect(put.status).toBe(200);

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/template?name=legacy-del&folder=&target=user`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { existed: boolean };
    expect(body.existed).toBe(true);
  });

  test('method-not-allowed on PATCH emits problem+json with Allow: GET, PUT, POST, DELETE', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, { method: 'PATCH' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, PUT, POST, DELETE');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
