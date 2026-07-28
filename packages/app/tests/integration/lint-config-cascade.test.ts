/**
 * L1 integration coverage for per-doc lint-config resolution over HTTP:
 * `GET /api/lint/config?doc=` follows the markdownlint-cli2 cascade (the
 * nearest `.markdownlint.*` file on the doc→root walk governs WHOLESALE), a
 * governing file is honored pure-native (no OK-tuned underlay), problems are
 * reported loudly, and the agent write path lints with the same per-doc
 * config.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MARKDOWNLINT_CONFIG } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;

beforeAll(async () => {
  // markdownlint is opt-in (off by default); this file exercises the lint
  // config cascade, so enable it for the whole test server.
  server = await createTestServer({ markdownlintEnabled: true });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

interface LintConfigBody {
  effective?: {
    plugins?: { markdownlint?: { rules?: Record<string, unknown> } };
  };
  configFile?: string | null;
  configProblems?: string[];
}

async function getLintConfig(doc?: string): Promise<LintConfigBody> {
  const query = doc ? `?doc=${encodeURIComponent(doc)}` : '';
  const res = await fetch(`http://127.0.0.1:${server.port}/api/lint/config${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as LintConfigBody;
}

function rules(body: LintConfigBody): Record<string, unknown> | undefined {
  return body.effective?.plugins?.markdownlint?.rules;
}

describe('GET /api/lint/config per-doc cascade', () => {
  test('no native file → OK tuned defaults, configFile null', async () => {
    const body = await getLintConfig('some-doc');
    expect(rules(body)).toEqual(DEFAULT_MARKDOWNLINT_CONFIG);
    expect(body.configFile).toBeNull();
    expect(body.configProblems).toEqual([]);
  });

  test('a governing root file is honored pure-native (wholesale, no OK underlay)', async () => {
    writeFileSync(
      join(server.contentDir, '.markdownlint.json'),
      JSON.stringify({ MD013: false }),
      'utf-8',
    );
    try {
      const body = await getLintConfig('some-doc');
      // Exactly the file's config — MD033/MD041 tuned disables do NOT leak in.
      expect(rules(body)).toEqual({ MD013: false });
      expect(body.configFile).toBe('.markdownlint.json');
    } finally {
      rmSync(join(server.contentDir, '.markdownlint.json'), { force: true });
    }
  });

  test('the nearest folder file governs docs under it; the root file governs the rest', async () => {
    const folder = join(server.contentDir, 'cascade-notes');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(server.contentDir, '.markdownlint.json'),
      JSON.stringify({ MD013: false, MD041: false }),
      'utf-8',
    );
    writeFileSync(join(folder, '.markdownlint.json'), JSON.stringify({ MD010: false }), 'utf-8');
    try {
      const inFolder = await getLintConfig('cascade-notes/doc');
      expect(rules(inFolder)).toEqual({ MD010: false });
      expect(inFolder.configFile).toBe(join('cascade-notes', '.markdownlint.json'));

      const atRoot = await getLintConfig('root-doc');
      expect(rules(atRoot)).toEqual({ MD013: false, MD041: false });
      expect(atRoot.configFile).toBe('.markdownlint.json');
    } finally {
      rmSync(join(server.contentDir, '.markdownlint.json'), { force: true });
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('a malformed governing file keeps defaults and reports the problem loudly', async () => {
    writeFileSync(join(server.contentDir, '.markdownlint.json'), '{ not valid', 'utf-8');
    try {
      const body = await getLintConfig('some-doc');
      expect(rules(body)).toEqual(DEFAULT_MARKDOWNLINT_CONFIG);
      expect(body.configProblems).toEqual([
        expect.stringContaining('malformed markdownlint config'),
      ]);
    } finally {
      rmSync(join(server.contentDir, '.markdownlint.json'), { force: true });
    }
  });

  test('a severity-string rule value loads verbatim instead of failing the fetch', async () => {
    writeFileSync(
      join(server.contentDir, '.markdownlint.json'),
      JSON.stringify({ MD010: 'error', MD013: 'warning' }),
      'utf-8',
    );
    try {
      const body = await getLintConfig('some-doc');
      expect(rules(body)).toEqual({ MD010: 'error', MD013: 'warning' });
      expect(body.configFile).toBe('.markdownlint.json');
      // Severity strings are native markdownlint vocabulary, not a config problem.
      expect(body.configProblems).toEqual([]);
    } finally {
      rmSync(join(server.contentDir, '.markdownlint.json'), { force: true });
    }
  });

  test('lint still runs on a doc governed by a severity-string config', async () => {
    const folder = join(server.contentDir, 'severity-notes');
    mkdirSync(folder, { recursive: true });
    // 'error' enables MD010 (truthy, default params) — the hard-tab body must warn.
    writeFileSync(join(folder, '.markdownlint.json'), JSON.stringify({ MD010: 'error' }), 'utf-8');
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown: '# Doc\n\n\tindented with a hard tab\n',
          position: 'replace',
          docName: `severity-notes/tabbed-${crypto.randomUUID().slice(0, 8)}`,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { warnings?: { kind: string; code?: string }[] };
      const lint = (body.warnings ?? []).filter((w) => w.kind === 'lint-violation');
      expect(lint.find((w) => w.code === 'MD010')).toBeDefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('agent writes lint with the folder-governed config, not the root one', async () => {
    const folder = join(server.contentDir, 'cascade-agent');
    mkdirSync(folder, { recursive: true });
    // Folder file disables MD010 (hard tabs) — the hard-tab body must NOT warn.
    writeFileSync(
      join(folder, '.markdownlint.json'),
      JSON.stringify({ MD010: false, MD047: false }),
      'utf-8',
    );
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown: '# Doc\n\n\tindented with a hard tab\n',
          position: 'replace',
          docName: `cascade-agent/tabbed-${crypto.randomUUID().slice(0, 8)}`,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { warnings?: { kind: string; code?: string }[] };
      const lint = (body.warnings ?? []).filter((w) => w.kind === 'lint-violation');
      expect(lint.find((w) => w.code === 'MD010')).toBeUndefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
