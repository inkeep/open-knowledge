/**
 * Per-handler narrow-integration smoke test for `handleFolderConfig`.
 *
 * Asserts the canonical RFC 9457 wire shape for `GET / PUT /api/folder-config`:
 *   - GET happy path: 200, flat success body, parses against
 *     `FolderConfigGetSuccessSchema`, no `ok` discriminator.
 *   - PUT happy path on root folder: 200, flat success body with
 *     `applied` field, parses against `FolderConfigPutSuccessSchema`.
 *   - GET path-traversal attempt → 400 + `urn:ok:error:invalid-request`.
 *   - method-not-allowed on DELETE emits 405 + `Allow: GET, PUT` header.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  FolderConfigGetSuccessSchema,
  FolderConfigPutSuccessSchema,
  ProblemDetailsSchema,
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

describe('folder-config envelope (RFC 9457)', () => {
  test('GET happy path emits flat success body with application/json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/folder-config?path=`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = FolderConfigGetSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('PUT happy path on root folder emits flat success body', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/folder-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '', frontmatter: { tags: ['root'] } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = FolderConfigPutSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('PUT with an arbitrary (non-well-known) key succeeds — folder frontmatter is open-shape', async () => {
    // Folder frontmatter works like a doc's: any key is accepted, not just
    // the conventional title/description/tags.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/folder-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '', frontmatter: { status: 'draft' } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = FolderConfigPutSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('GET path-traversal attempt emits urn:ok:error:invalid-request', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/folder-config?path=${encodeURIComponent('../etc')}`,
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

  test('method-not-allowed on DELETE emits problem+json with Allow: GET, PUT', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/folder-config`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, PUT');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
