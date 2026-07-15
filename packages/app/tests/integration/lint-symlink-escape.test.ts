/**
 * L1 integration coverage for symlink containment on the lint HTTP surface:
 * `GET /api/lint?doc=` refuses a symlink escaping the content dir with a
 * path-escape 400, `GET /api/lint/audit?path=` over an escaped symlinked
 * scope returns 200 with a warning and no leaked source text, and symlinks
 * resolving inside the content dir keep linting normally. Also pins that
 * `?doc=` accepts an extension-carrying docName.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;
let outside: string;

const SECRET = 'TOP-SECRET-OUTSIDE-CONTENT-8f3a';
// With markdownlint enabled, MD010 (hard tabs) flags a doc with a tab.
const DOC_WITH_TAB = '# Title\n\n\tindented with a tab\n';

beforeAll(async () => {
  // markdownlint is opt-in (off by default); this file exercises the lint
  // endpoint, so enable it for the whole test server.
  server = await createTestServer({ markdownlintEnabled: true });
  outside = mkdtempSync(join(tmpdir(), 'ok-lint-outside-'));
  writeFileSync(join(outside, 'secret.md'), `# Secret\n\n\t${SECRET}\n`, 'utf-8');
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  rmSync(outside, { recursive: true, force: true });
  await server.cleanup();
});

async function getLint(doc: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/lint?doc=${encodeURIComponent(doc)}`);
}

describe('GET /api/lint symlink containment', () => {
  test('a symlink escaping the content dir is refused with a path-escape 400', async () => {
    symlinkSync(join(outside, 'secret.md'), join(server.contentDir, 'lint-escape.md'));
    const res = await getLint('lint-escape');
    expect(res.status).toBe(400);
    const text = await res.text();
    expect((JSON.parse(text) as { type: string }).type).toBe('urn:ok:error:path-escape');
    expect(text).not.toContain(SECRET);
  });

  test('a symlink resolving inside the content dir lints normally', async () => {
    writeFileSync(join(server.contentDir, 'lint-inside-real.md'), DOC_WITH_TAB, 'utf-8');
    symlinkSync(
      join(server.contentDir, 'lint-inside-real.md'),
      join(server.contentDir, 'lint-inside-alias.md'),
    );
    const res = await getLint('lint-inside-alias');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diagnostics: { code: string }[] };
    expect(body.diagnostics.some((d) => d.code === 'MD010')).toBe(true);
  });

  test('an extension-carrying docName resolves', async () => {
    writeFileSync(join(server.contentDir, 'lint-explicit-ext.md'), DOC_WITH_TAB, 'utf-8');
    const res = await getLint('lint-explicit-ext.md');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { file: string; diagnostics: { code: string }[] };
    expect(body.file).toBe('lint-explicit-ext.md');
    expect(body.diagnostics.some((d) => d.code === 'MD010')).toBe(true);
  });
});

describe('POST /api/lint/fix symlink containment', () => {
  test('a symlink escaping the content dir is refused and leaks no content', async () => {
    symlinkSync(join(outside, 'secret.md'), join(server.contentDir, 'lint-fix-escape.md'));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/lint/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName: 'lint-fix-escape', agentId: 'sym-fix-agent' }),
    });
    // The mutating fix endpoint must refuse the escape (never linting/returning
    // or writing back the outside secret) — same containment the read path has.
    expect(res.status).toBe(400);
    const text = await res.text();
    expect((JSON.parse(text) as { type: string }).type).toBe('urn:ok:error:path-escape');
    expect(text).not.toContain(SECRET);
  });
});

describe('GET /api/lint/audit symlink containment', () => {
  test('a scope through an escaped symlinked dir warns and leaks no content', async () => {
    symlinkSync(outside, join(server.contentDir, 'lint-audit-linked'));
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/lint/audit?path=lint-audit-linked`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { files: unknown[]; warnings: string[] };
    expect(body.files).toEqual([]);
    expect(body.warnings).toEqual([expect.stringContaining('symlink-escape')]);
    expect(text).not.toContain(SECRET);
  });

  test('a scope targeting an escaping symlinked file warns and leaks no content', async () => {
    symlinkSync(join(outside, 'secret.md'), join(server.contentDir, 'lint-audit-escape.md'));
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/lint/audit?path=lint-audit-escape.md`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { files: unknown[]; warnings: string[] };
    expect(body.files).toEqual([]);
    expect(body.warnings).toEqual([expect.stringContaining('symlink-escape')]);
    expect(text).not.toContain(SECRET);
  });
});
