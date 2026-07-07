/**
 * Per-handler narrow-integration smoke test for `handleUploadAsset`.
 *
 * Asserts the canonical RFC 9457 wire shape:
 *   - happy-path: status 200, `Content-Type: application/json`, body parses
 *     against `UploadAssetSuccessSchema`, no `ok: true` discriminator.
 *   - error-path: status 400, `Content-Type: application/problem+json`, body
 *     parses against `ProblemDetailsSchema`, `instance` is a UUID matching
 *     `body.status === HTTP status`.
 *
 * Real server + real handler + real schema. Mocks only the in-process
 * test-harness boundary (Hocuspocus server, contentDir tempdir).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProblemDetailsSchema, UploadAssetSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
  // Seed a parent doc so `parentDocName` resolves to a real directory.
  mkdirSync(join(server.contentDir, 'docs'), { recursive: true });
  writeFileSync(join(server.contentDir, 'docs', 'guide.md'), '# Guide\n');
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function pngFixture(): Buffer {
  // Minimal valid PNG (1×1 transparent pixel).
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElEQrkJggg==',
    'base64',
  );
}

async function postUpload(form: FormData): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/upload`, {
    method: 'POST',
    body: form,
  });
}

const UUID_RE = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('upload-asset envelope (RFC 9457)', () => {
  test('happy path emits flat success body with application/json', async () => {
    const form = new FormData();
    form.append('parentDocName', 'docs/guide.md');
    form.append('file', new Blob([pngFixture()]), 'shot-success.png');

    const res = await postUpload(form);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = UploadAssetSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.src).toBe('shot-success.png');
      expect(parsed.data.path).toBe('docs/shot-success.png');
      expect(parsed.data.deduped).toBe(false);
    }

    // Wire shape: no `ok: true` discriminator on success bodies.
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('missing parentDocName emits ProblemDetails with application/problem+json', async () => {
    const form = new FormData();
    form.append('file', new Blob([pngFixture()]), 'orphan.png');

    const res = await postUpload(form);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.status).toBe(400);
      expect(parsed.data.title.length).toBeGreaterThan(0);
      // RFC 9457 instance is a UUID; same UUID is mirrored in the
      // Pino structured log line for grep correlation.
      expect(parsed.data.instance).toBeDefined();
      if (parsed.data.instance) {
        expect(parsed.data.instance).toMatch(UUID_RE);
      }
      // body.status MUST equal HTTP response status.
      expect(parsed.data.status).toBe(res.status);
    }
  });

  test('path-escape attempt emits urn:ok:error:path-escape', async () => {
    const form = new FormData();
    form.append('parentDocName', '../../etc/passwd.md');
    form.append('file', new Blob([pngFixture()]), 'escape.png');

    const res = await postUpload(form);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:path-escape');
      expect(parsed.data.status).toBe(400);
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('allow')).toBe('POST');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
      expect(parsed.data.status).toBe(405);
    }
  });
});
