/**
 * Per-handler narrow-integration smoke test for `handleTemplatesList`.
 *
 * Asserts the canonical wire shape for `GET /api/templates`:
 *   - GET on empty project → 200 + `{ templates: [] }`.
 *   - After seeding a template via `PUT /api/template`, the new entry
 *     appears in `GET /api/templates` and the response parses cleanly
 *     against `TemplatesListSuccessSchema.strict()`.
 *   - The handler strips `scope` from the resolver output — `.strict()`
 *     would reject the response if `scope` leaked through.
 *   - method-not-allowed on POST emits 405.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TemplatesListSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('templates-list envelope', () => {
  test('GET on empty project returns 200 with empty templates array', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/templates`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    const parsed = TemplatesListSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.templates).toEqual([]);
      expect(parsed.data.truncated).toBe(false);
    }
  });

  test('GET after PUT surfaces the new entry with source_folder + no scope leak', async () => {
    // Seed a template at the project root.
    const putRes = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: '',
        name: 'daily-note',
        body: '# Daily note',
        frontmatter: { title: 'Daily note', description: 'Date-stamped log' },
      }),
    });
    expect(putRes.status).toBe(200);

    // Fetch the flat list.
    const listRes = await fetch(`http://127.0.0.1:${server.port}/api/templates`);
    expect(listRes.status).toBe(200);

    const body = (await listRes.json()) as Record<string, unknown>;
    const parsed = TemplatesListSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const entry = parsed.data.templates.find((t) => t.name === 'daily-note');
    expect(entry).toBeDefined();
    expect(entry?.source_folder).toBe('');
    expect(entry?.title).toBe('Daily note');

    // The handler maps the resolver entry through a `{ scope, ...rest }`
    // strip; without that, `TemplatesListEntrySchema.strict()` rejects
    // the response and the safeParse above fails. Belt-and-braces: assert
    // the field is absent on the raw body too.
    const rawEntry = ((body.templates as Array<Record<string, unknown>>) ?? []).find(
      (t) => t.name === 'daily-note',
    );
    expect(rawEntry?.scope).toBeUndefined();
  });

  test('POST returns 405 method-not-allowed', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });
});
