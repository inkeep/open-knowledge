import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ValidationAuditCountsResponse,
  ValidationAuditCountsResponseSchema,
  type ValidationAuditResponse,
  ValidationAuditResponseSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { awaitBacklinkIndexed, createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ markdownlintEnabled: true });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const TABBED_BODY = '# Doc\n\n\tindented with a hard tab\n';

const BACKLINK_SEED_TIMEOUT_MS = 45_000;

function api(pathAndQuery: string): string {
  return `http://127.0.0.1:${server.port}${pathAndQuery}`;
}

describe('GET /api/audit', () => {
  test('okf enabled reaches ran through the real config lift', async () => {
    const okfServer = await createTestServer({
      seedProjectConfigYml: 'contentRules:\n  okf:\n    enabled: true\nvalidation:\n  links: off\n',
    });
    try {
      const res = await fetch(`http://127.0.0.1:${okfServer.port}/api/audit`);
      expect(res.status).toBe(200);
      const body = ValidationAuditResponseSchema.parse(await res.json());
      expect(body.ran).toEqual(['okf']);
    } finally {
      await okfServer.cleanup();
    }
  });

  test('all validation sources off returns an explicit empty selection', async () => {
    const disabledServer = await createTestServer({
      seedProjectConfigYml: 'validation:\n  links: off\n',
    });
    try {
      const res = await fetch(`http://127.0.0.1:${disabledServer.port}/api/audit`);
      expect(res.status).toBe(200);
      const body = ValidationAuditResponseSchema.parse(await res.json());
      expect(body.ran).toEqual([]);
    } finally {
      await disabledServer.cleanup();
    }
  });

  test(
    'returns lint + dead-link findings in one source-tagged plane',
    async () => {
      const folder = join(server.contentDir, 'audit-http');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'tabbed.md'), TABBED_BODY, 'utf-8');
      writeFileSync(
        join(folder, 'linker.md'),
        '# Linker\n\nSee [[audit-http-ghost-target]].\n',
        'utf-8',
      );
      try {
        await awaitBacklinkIndexed(server, 'audit-http-ghost-target', 'audit-http/linker');

        const res = await fetch(api('/api/audit'));
        expect(res.status).toBe(200);
        const body: ValidationAuditResponse = ValidationAuditResponseSchema.parse(await res.json());
        expect(body.ran).toEqual(['markdownlint', 'links']);

        const tabbed = body.files.find((f) => f.file === 'audit-http/tabbed.md');
        const md010 = tabbed?.diagnostics.find((d) => d.code === 'MD010');
        expect(md010).toBeDefined();
        expect(md010?.source).toBe('markdownlint');

        const linker = body.files.find((f) => f.file === 'audit-http/linker.md');
        const dead = linker?.diagnostics.find((d) => d.code === 'dead-link');
        expect(dead).toBeDefined();
        expect(dead?.source).toBe('links');
        expect(dead?.severity).toBe('warning');
        expect(dead?.message).toContain('audit-http-ghost-target');
        expect(dead?.linkTarget).toBe('audit-http-ghost-target');
        expect(dead?.range.start.line).toBe(2);

        const flat = body.files.flatMap((f) => f.diagnostics);
        expect(body.errorCount).toBe(flat.filter((d) => d.severity === 'error').length);
        expect(body.warningCount).toBe(flat.filter((d) => d.severity !== 'error').length);
        expect(body.warningCount).toBeGreaterThanOrEqual(2);
        expect(body.fileCount).toBeGreaterThanOrEqual(2);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    BACKLINK_SEED_TIMEOUT_MS,
  );

  test(
    'doc scope flags the identical dead link as the whole-project audit',
    async () => {
      const folder = join(server.contentDir, 'audit-parity');
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, 'linker.md'),
        '# Linker\n\nSee [[audit-parity-ghost]].\n',
        'utf-8',
      );
      try {
        await awaitBacklinkIndexed(server, 'audit-parity-ghost', 'audit-parity/linker');

        const project = await fetch(api('/api/audit'));
        const docScoped = await fetch(api('/api/audit?path=audit-parity%2Flinker.md'));
        expect(project.status).toBe(200);
        expect(docScoped.status).toBe(200);
        const projectBody = ValidationAuditResponseSchema.parse(await project.json());
        const docBody = ValidationAuditResponseSchema.parse(await docScoped.json());

        const projectEntry = projectBody.files.find((f) => f.file === 'audit-parity/linker.md');
        const docEntry = docBody.files.find((f) => f.file === 'audit-parity/linker.md');
        expect(docEntry).toBeDefined();
        expect(docEntry?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);
        expect(docEntry).toEqual(projectEntry);

        expect(docBody.files.map((f) => f.file)).toEqual(['audit-parity/linker.md']);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    BACKLINK_SEED_TIMEOUT_MS,
  );

  test(
    'doc param scopes by extension-less docName to the same plane as path',
    async () => {
      const folder = join(server.contentDir, 'audit-docparam');
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, 'linker.md'),
        '# Linker\n\nSee [[audit-docparam-ghost]].\n',
        'utf-8',
      );
      try {
        await awaitBacklinkIndexed(server, 'audit-docparam-ghost', 'audit-docparam/linker');

        const byPath = await fetch(api('/api/audit?path=audit-docparam%2Flinker.md'));
        const byDoc = await fetch(api('/api/audit?doc=audit-docparam%2Flinker'));
        expect(byPath.status).toBe(200);
        expect(byDoc.status).toBe(200);
        const pathBody = ValidationAuditResponseSchema.parse(await byPath.json());
        const docBody = ValidationAuditResponseSchema.parse(await byDoc.json());

        expect(docBody).toEqual(pathBody);
        expect(docBody.files.some((f) => f.file === 'audit-docparam/linker.md')).toBe(true);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    BACKLINK_SEED_TIMEOUT_MS,
  );

  test('traversal and absolute paths are refused with the invalid-request envelope', async () => {
    for (const bad of ['../outside', '/etc/passwd']) {
      const res = await fetch(api(`/api/audit?path=${encodeURIComponent(bad)}`));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { type?: string };
      expect(body.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('doc param refuses traversal and combining with path', async () => {
    for (const bad of ['../outside', '/etc/passwd']) {
      const res = await fetch(api(`/api/audit?doc=${encodeURIComponent(bad)}`));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { type?: string };
      expect(body.type).toBe('urn:ok:error:invalid-request');
    }
    const both = await fetch(api('/api/audit?doc=a&path=b.md'));
    expect(both.status).toBe(400);
  });

  test(
    'counts=1 returns the same plane tallied per file and per source',
    async () => {
      const folder = join(server.contentDir, 'audit-counts');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'tabbed.md'), TABBED_BODY, 'utf-8');
      try {
        const enumeratedRes = await fetch(api('/api/audit?path=audit-counts'));
        const countsRes = await fetch(api('/api/audit?path=audit-counts&counts=1'));
        expect(enumeratedRes.status).toBe(200);
        expect(countsRes.status).toBe(200);

        const enumerated = ValidationAuditResponseSchema.parse(
          await enumeratedRes.json(),
        ) satisfies ValidationAuditResponse;
        const rawCounts: unknown = await countsRes.json();
        expect(rawCounts).not.toHaveProperty('ran');
        const counts = ValidationAuditCountsResponseSchema.parse(
          rawCounts,
        ) satisfies ValidationAuditCountsResponse;

        expect(counts.files.map((f) => f.file)).toEqual(enumerated.files.map((f) => f.file));
        expect(counts.errorCount).toBe(enumerated.errorCount);
        expect(counts.warningCount).toBe(enumerated.warningCount);
        expect(counts.fileCount).toBe(enumerated.fileCount);

        const tabbed = counts.files.find((f) => f.file.endsWith('tabbed.md'));
        expect(tabbed).toBeDefined();
        expect(tabbed?.lint.warningCount).toBeGreaterThan(0);
        expect(Object.keys(tabbed ?? {}).sort()).toEqual(['file', 'links', 'lint']);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'concurrent identical audits are coalesced and agree',
    async () => {
      const folder = join(server.contentDir, 'audit-coalesce');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'tabbed.md'), TABBED_BODY, 'utf-8');
      try {
        const responses = await Promise.all([
          fetch(api('/api/audit?path=audit-coalesce&counts=1')),
          fetch(api('/api/audit?path=audit-coalesce&counts=1')),
          fetch(api('/api/audit?path=audit-coalesce&counts=1')),
          fetch(api('/api/audit?path=audit-coalesce')),
        ]);
        for (const response of responses) expect(response.status).toBe(200);

        const bodies = await Promise.all(responses.map((r) => r.json()));
        const countsBodies = bodies
          .slice(0, 3)
          .map((body) => ValidationAuditCountsResponseSchema.parse(body));
        expect(countsBodies[1]).toEqual(countsBodies[0]);
        expect(countsBodies[2]).toEqual(countsBodies[0]);

        const enumerated = ValidationAuditResponseSchema.parse(bodies[3]);
        expect(enumerated.errorCount).toBe(countsBodies[0]?.errorCount);
        expect(enumerated.warningCount).toBe(countsBodies[0]?.warningCount);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});
