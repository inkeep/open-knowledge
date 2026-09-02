import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LINT_PLUGINS,
  type LintAuditResponse,
  LintAuditResponseSchema,
  type LintConfigResponse,
  LintConfigResponseSchema,
  type LintDocResult,
  LintDocResultSchema,
  type LintFixResult,
  LintFixResultSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ markdownlintEnabled: true });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const TABBED_BODY = '# Doc\n\n\tindented with a hard tab\n';

function api(pathAndQuery: string): string {
  return `http://127.0.0.1:${server.port}${pathAndQuery}`;
}

describe('GET /api/lint (single document)', () => {
  test('a seeded doc with a violation lints to 200 + schema-valid diagnostics', async () => {
    const folder = join(server.contentDir, 'lint-http');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'tabbed.md'), TABBED_BODY, 'utf-8');
    try {
      const res = await fetch(api('/api/lint?doc=lint-http%2Ftabbed'));
      expect(res.status).toBe(200);
      const body: LintDocResult = LintDocResultSchema.parse(await res.json());
      expect(body.file).toBe('lint-http/tabbed.md');
      expect(body.ran).toEqual(['markdownlint']);
      expect(body).not.toHaveProperty('warnings');
      const md010 = body.diagnostics.find((d) => d.code === 'MD010');
      expect(md010).toBeDefined();
      expect(md010?.source).toBe('markdownlint');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('a missing doc param is a 400', async () => {
    const res = await fetch(api('/api/lint'));
    expect(res.status).toBe(400);
  });

  test('an unknown doc is a 404', async () => {
    const res = await fetch(api(`/api/lint?doc=no-such-doc-${crypto.randomUUID().slice(0, 8)}`));
    expect(res.status).toBe(404);
  });

  test('a selected plugin degradation stays in ran and is named in warnings', async () => {
    const folder = join(server.contentDir, 'lint-http-degraded');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'doc.md'), TABBED_BODY, 'utf-8');
    const markdownlint = LINT_PLUGINS.find((plugin) => plugin.id === 'markdownlint');
    if (!markdownlint) throw new Error('markdownlint plugin missing');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lint = vi.spyOn(markdownlint, 'lint').mockRejectedValue(new Error('unavailable'));
    try {
      const res = await fetch(api('/api/lint?doc=lint-http-degraded%2Fdoc'));
      expect(res.status).toBe(200);
      const body = LintDocResultSchema.parse(await res.json());
      expect(body.ran).toEqual(['markdownlint']);
      expect(body.warnings).toEqual([
        'source "markdownlint" lint failed on "lint-http-degraded/doc.md": unavailable',
      ]);
    } finally {
      lint.mockRestore();
      warn.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('GET /api/lint/audit', () => {
  test('groups diagnostics per file across seeded docs; ?path= scopes the walk', async () => {
    const folder = join(server.contentDir, 'lint-http-audit');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'a.md'), TABBED_BODY, 'utf-8');
    writeFileSync(join(folder, 'b.md'), TABBED_BODY, 'utf-8');
    try {
      const full = await fetch(api('/api/lint/audit'));
      expect(full.status).toBe(200);
      const fullBody: LintAuditResponse = LintAuditResponseSchema.parse(await full.json());
      const fullFiles = fullBody.files.map((f) => f.file);
      expect(fullFiles).toEqual(
        expect.arrayContaining(['lint-http-audit/a.md', 'lint-http-audit/b.md']),
      );
      for (const f of fullBody.files) {
        expect(f.diagnostics.length).toBeGreaterThan(0);
      }
      expect(fullBody.fileCount).toBeGreaterThanOrEqual(2);
      expect(fullBody.ran).toEqual(['markdownlint']);

      const scoped = await fetch(api('/api/lint/audit?path=lint-http-audit'));
      expect(scoped.status).toBe(200);
      const scopedBody: LintAuditResponse = LintAuditResponseSchema.parse(await scoped.json());
      expect(scopedBody.files.map((f) => f.file).sort()).toEqual([
        'lint-http-audit/a.md',
        'lint-http-audit/b.md',
      ]);
      expect(scopedBody.fileCount).toBe(2);
      expect(scopedBody.ran).toEqual(['markdownlint']);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('POST /api/lint/fix', () => {
  async function postFix(docName: string): Promise<Response> {
    return fetch(api('/api/lint/fix'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, agentId: 'lint-fix-agent' }),
    });
  }

  test('auto-fixes a fixable violation in place, preserving frontmatter', async () => {
    const folder = join(server.contentDir, 'lint-fix');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'tabbed.md');
    writeFileSync(
      file,
      '---\ntitle: Keep Me\n---\n\n# Doc\n\n\tindented with a hard tab\n',
      'utf-8',
    );
    try {
      const res = await postFix('lint-fix/tabbed');
      expect(res.status).toBe(200);
      const body: LintFixResult = LintFixResultSchema.parse(await res.json());
      expect(body.file).toBe('lint-fix/tabbed.md');
      expect(body.ran).toEqual(['markdownlint']);
      expect(body.fixedCount).toBeGreaterThanOrEqual(1);
      expect(body.diagnostics.find((d) => d.code === 'MD010')).toBeUndefined();
      const onDisk = readFileSync(file, 'utf-8');
      expect(onDisk).not.toContain('\t');
      expect(onDisk).toContain('title: Keep Me');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('a throwing plugin lands in warnings while the fix write stays durable', async () => {
    const folder = join(server.contentDir, 'lint-fix-degraded');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'tabbed.md');
    writeFileSync(
      file,
      '---\ntitle: Keep Me\n---\n\n# Doc\n\n\tindented with a hard tab\n',
      'utf-8',
    );
    const markdownlint = LINT_PLUGINS.find((plugin) => plugin.id === 'markdownlint');
    if (!markdownlint) throw new Error('markdownlint plugin missing');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lint = vi.spyOn(markdownlint, 'lint').mockRejectedValue(new Error('unavailable'));
    try {
      const res = await postFix('lint-fix-degraded/tabbed');
      expect(res.status).toBe(200);
      const body = LintFixResultSchema.parse(await res.json());
      expect(body.ran).toEqual(['markdownlint']);
      expect(body.warnings).toEqual([
        'source "markdownlint" lint failed on "lint-fix-degraded/tabbed.md": unavailable',
      ]);
      const onDisk = readFileSync(file, 'utf-8');
      expect(onDisk).not.toContain('\t');
      expect(onDisk).toContain('title: Keep Me');
    } finally {
      lint.mockRestore();
      warn.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('a clean doc is a no-op: fixedCount 0, no remaining diagnostics', async () => {
    const folder = join(server.contentDir, 'lint-fix-clean');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'ok.md'), '# Clean\n\nNo problems here.\n', 'utf-8');
    try {
      const res = await postFix('lint-fix-clean/ok');
      expect(res.status).toBe(200);
      const body = LintFixResultSchema.parse(await res.json());
      expect(body.fixedCount).toBe(0);
      expect(body.diagnostics).toHaveLength(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('an unknown doc is a 404', async () => {
    const res = await postFix(`no-such-doc-${crypto.randomUUID().slice(0, 8)}`);
    expect(res.status).toBe(404);
  });

  test('a bare body (no agentId) fixes as the principal and surfaces no agent presence', async () => {
    const folder = join(server.contentDir, 'lint-fix-principal');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'tabbed.md');
    writeFileSync(file, '# Doc\n\n\tindented with a hard tab\n', 'utf-8');
    try {
      const res = await fetch(api('/api/lint/fix'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName: 'lint-fix-principal/tabbed' }),
      });
      expect(res.status).toBe(200);
      const body = LintFixResultSchema.parse(await res.json());
      expect(body.fixedCount).toBeGreaterThanOrEqual(1);
      expect(readFileSync(file, 'utf-8')).not.toContain('\t');
      const presence = await fetch(api('/api/metrics/agent-presence'));
      const map = (await presence.json()) as { agents?: Record<string, unknown> };
      const ids = Object.keys(map.agents ?? map);
      expect(ids.some((id) => id.startsWith('principal-'))).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('a non-string summary is a 400', async () => {
    const res = await fetch(api('/api/lint/fix'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName: 'anything', summary: 123 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('zero selected lint sources', () => {
  test('single-doc, project, and fix success responses emit ran: []', async () => {
    const disabledServer = await createTestServer();
    const disabledApi = (path: string) => `http://127.0.0.1:${disabledServer.port}${path}`;
    try {
      const doc = LintDocResultSchema.parse(
        await (await fetch(disabledApi('/api/lint?doc=test-doc'))).json(),
      );
      const audit = LintAuditResponseSchema.parse(
        await (await fetch(disabledApi('/api/lint/audit'))).json(),
      );
      const fix = LintFixResultSchema.parse(
        await (
          await fetch(disabledApi('/api/lint/fix'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ docName: 'test-doc', agentId: 'zero-source-agent' }),
          })
        ).json(),
      );

      expect(doc.ran).toEqual([]);
      expect(audit.ran).toEqual([]);
      expect(fix.ran).toEqual([]);
    } finally {
      await disabledServer.cleanup();
    }
  });
});

describe('POST /api/lint/markdownlint-config', () => {
  async function postRule(ruleId: string, value: unknown): Promise<Response> {
    return fetch(api('/api/lint/markdownlint-config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ruleId, value }),
    });
  }

  test('setting a rule returns the recomputed effective config and lands on disk', async () => {
    const nativeFile = join(server.contentDir, '.markdownlint.json');
    try {
      const res = await postRule('MD012', { maximum: 3 });
      expect(res.status).toBe(200);
      const body: LintConfigResponse = LintConfigResponseSchema.parse(await res.json());
      expect(body.effective.plugins.markdownlint.rules.MD012).toEqual({ maximum: 3 });
      expect(body.configFile).toBe('.markdownlint.json');

      expect(existsSync(nativeFile)).toBe(true);
      expect(readFileSync(nativeFile, 'utf-8')).toContain('"MD012"');
    } finally {
      rmSync(nativeFile, { force: true });
    }
  });

  test('an executable native config declines the write with a 409', async () => {
    const cjsFile = join(server.contentDir, '.markdownlint.cjs');
    writeFileSync(cjsFile, 'module.exports = { MD010: false };\n', 'utf-8');
    try {
      const res = await postRule('MD012', false);
      expect(res.status).toBe(409);
      expect(readFileSync(cjsFile, 'utf-8')).toBe('module.exports = { MD010: false };\n');
    } finally {
      rmSync(cjsFile, { force: true });
    }
  });
});
