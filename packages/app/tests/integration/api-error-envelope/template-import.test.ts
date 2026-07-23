/**
 * Narrow-integration smoke test for `handleTemplateImport`
 * (`POST /api/template/import`).
 *
 * Covers the two user-facing paths from the File Tree "Import as template"
 * menu plus a guard:
 *   - Keep original: template created, source doc left intact.
 *   - Convert (delete original): template created AND source doc removed from
 *     disk. This is the destructive path, so it gets an explicit assertion.
 *   - Regression guard for the source `title` NOT being baked into the
 *     instantiated doc-frontmatter (it belongs only in the `template:`
 *     identity block).
 *   - Missing source → 404 + `urn:ok:error:doc-not-found`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProblemDetailsSchema, TemplateImportSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer, wait } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function writeSource(docName: string, markdown: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, position: 'replace', docName }),
  });
  expect(res.status).toBe(200);
  // The import handler reads the source file off disk (existsSync gate), so wait
  // for the persistence debounce to flush before importing.
  const filePath = join(server.contentDir, `${docName}.md`);
  for (let i = 0; i < 100; i++) {
    if (existsSync(filePath)) return;
    await wait(50);
  }
  throw new Error(`source ${docName}.md never flushed to disk`);
}

function importTemplate(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/template/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('template import (POST /api/template/import)', () => {
  test('keep original: template created, source left intact', async () => {
    await writeSource('src-keep', '---\ntitle: Keep Source\n---\n\n# Heading\n\nbody text\n');

    const res = await importTemplate({
      sourcePath: 'src-keep',
      targetFolder: '',
      deleteSource: false,
    });
    expect(res.status).toBe(200);
    const parsed = TemplateImportSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.created).toBe(true);
      expect(parsed.data.path).toContain('.ok/templates/src-keep.md');
    }

    expect(existsSync(join(server.contentDir, '.ok', 'templates', 'src-keep.md'))).toBe(true);
    expect(existsSync(join(server.contentDir, 'src-keep.md'))).toBe(true);
  });

  test('title is not baked into the instantiated doc-frontmatter', async () => {
    await writeSource('src-title', '---\ntitle: UniqueImportTitleXYZ\n---\n\n# Heading\n\nbody\n');

    const res = await importTemplate({ sourcePath: 'src-title', targetFolder: '' });
    expect(res.status).toBe(200);

    const tmpl = readFileSync(join(server.contentDir, '.ok', 'templates', 'src-title.md'), 'utf-8');
    // The title lives ONLY in the `template:` identity block; if it were also
    // carried into the instantiated doc-frontmatter it would appear twice.
    const occurrences = tmpl.split('UniqueImportTitleXYZ').length - 1;
    expect(occurrences).toBe(1);
  });

  test('convert: template created AND source doc deleted', async () => {
    await writeSource('src-convert', '---\ntitle: Convert Source\n---\n\n# Doc\n\nbody\n');
    expect(existsSync(join(server.contentDir, 'src-convert.md'))).toBe(true);

    const res = await importTemplate({
      sourcePath: 'src-convert',
      targetFolder: '',
      deleteSource: true,
    });
    expect(res.status).toBe(200);
    const parsed = TemplateImportSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);

    expect(existsSync(join(server.contentDir, '.ok', 'templates', 'src-convert.md'))).toBe(true);
    // The destructive half: the source document must be gone from disk.
    for (let i = 0; i < 100; i++) {
      if (!existsSync(join(server.contentDir, 'src-convert.md'))) break;
      await wait(50);
    }
    expect(existsSync(join(server.contentDir, 'src-convert.md'))).toBe(false);
  });

  test('missing source emits 404 + doc-not-found', async () => {
    const res = await importTemplate({ sourcePath: 'no-such-doc', targetFolder: '' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:doc-not-found');
    }
  });
});
