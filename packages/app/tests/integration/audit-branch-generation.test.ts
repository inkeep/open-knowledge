import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationAuditResponseSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ markdownlintEnabled: true });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const SCOPE = 'audit-branch';

const DOC_COUNT = 60;
const LINE_COUNT = 800;

const TEST_TIMEOUT_MS = 120_000;

function api(pathAndQuery: string): string {
  return `http://127.0.0.1:${server.port}${pathAndQuery}`;
}

function writeCorpus(folder: string, separator: '\t' | ' '): void {
  const lines = ['# Title', ''];
  for (let i = 0; i < LINE_COUNT; i += 1) {
    lines.push(`Paragraph ${i} with${separator}a hard tab and some filler text.`, '');
  }
  const text = lines.join('\n');
  mkdirSync(folder, { recursive: true });
  for (let i = 0; i < DOC_COUNT; i += 1) {
    writeFileSync(join(folder, `doc-${i}.md`), text, 'utf-8');
  }
}

async function auditScope(): Promise<Response> {
  return fetch(api(`/api/audit?path=${SCOPE}`));
}

function parseAudit(body: unknown): { md010: number; fileCount: number } {
  const parsed = ValidationAuditResponseSchema.parse(body);
  return {
    md010: parsed.files.flatMap((f) => f.diagnostics).filter((d) => d.code === 'MD010').length,
    fileCount: parsed.fileCount,
  };
}

describe('GET /api/audit across a branch switch', () => {
  test(
    'an audit issued after a branch switch is never served the pre-switch plane',
    async () => {
      const folder = join(server.contentDir, SCOPE);
      writeCorpus(folder, '\t');
      try {
        const before = await fetch(api(`/api/audit?path=${SCOPE}%2Fdoc-0.md`));
        expect(before.status).toBe(200);
        expect(parseAudit(await before.json()).md010).toBeGreaterThan(0);

        let firstSettled = false;
        const first = auditScope().then((res) => {
          firstSettled = true;
          return res;
        });

        expect((await fetch(api('/api/lint/config'))).status).toBe(200);

        writeCorpus(folder, ' ');
        const { durabilityState } = server.instance;
        expect(durabilityState.getActiveBranch()).not.toBe('audit-branch-target');
        durabilityState.switchReconciledBaseScope('audit-branch-target');

        expect(firstSettled).toBe(false);

        const after = await auditScope();
        expect(after.status).toBe(200);
        const afterPlane = parseAudit(await after.json());
        expect(afterPlane.fileCount).toBe(DOC_COUNT);
        expect(afterPlane.md010).toBe(0);

        const firstRes = await first;
        expect(firstRes.status).toBe(409);
        const problem = (await firstRes.json()) as { type?: string };
        expect(problem.type).toBe('urn:ok:error:audit-superseded');
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
