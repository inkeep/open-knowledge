import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  bindConfigDoc,
  CONFIG_DOC_NAME_PROJECT,
  ValidationAuditResponseSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { type AuditBarrier, pauseAuditAtDocument } from './audit-barrier.test-helper.ts';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  awaitBacklinkIndexed,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness.ts';

let server: TestServer;

const SEED_CONFIG = [
  'contentRules:',
  '  markdownlint:',
  '    enabled: true',
  '  frontmatter:',
  '    enabled: true',
  '    schemas:',
  '      - appliesTo: "audit-epoch/**"',
  '        file: ".ok/schemas/audit-epoch.schema.json"',
  '',
].join('\n');

beforeAll(async () => {
  server = await createTestServer({ seedProjectConfigYml: SEED_CONFIG });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const SCOPE = 'audit-epoch';

const DOC_COUNT = 60;
const LINE_COUNT = 800;

const TEST_TIMEOUT_MS = 120_000;

function api(pathAndQuery: string): string {
  return `http://127.0.0.1:${server.port}${pathAndQuery}`;
}

function seedTabbedCorpus(folder: string): void {
  const lines = ['# Title', ''];
  for (let i = 0; i < LINE_COUNT; i += 1) {
    lines.push(`Paragraph ${i} with\ta hard tab and some filler text.`, '');
  }
  const text = lines.join('\n');
  mkdirSync(folder, { recursive: true });
  for (let i = 0; i < DOC_COUNT; i += 1) {
    writeFileSync(join(folder, `doc-${i}.md`), text, 'utf-8');
  }
}

async function auditScope(scope = SCOPE): Promise<Response> {
  return fetch(api(`/api/audit?path=${scope}`));
}

function md010Count(body: unknown): number {
  const parsed = ValidationAuditResponseSchema.parse(body);
  return parsed.files.flatMap((f) => f.diagnostics).filter((d) => d.code === 'MD010').length;
}

describe('GET /api/audit across a lint-config change', () => {
  test(
    'an audit issued after a rule write is never served the pre-write plane',
    async () => {
      const folder = join(server.contentDir, SCOPE);
      const nativeFile = join(server.contentDir, '.markdownlint.json');
      seedTabbedCorpus(folder);
      let auditBarrier: AuditBarrier | undefined;
      try {
        const before = await fetch(api(`/api/audit?path=${SCOPE}%2Fdoc-0.md`));
        expect(before.status).toBe(200);
        expect(md010Count(await before.json())).toBeGreaterThan(0);

        auditBarrier = pauseAuditAtDocument(`${SCOPE}/doc-1.md`);
        const first = auditScope();
        await auditBarrier.waitUntilStarted();

        const write = await fetch(api('/api/lint/markdownlint-config'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ruleId: 'MD010', value: false }),
        });
        expect(write.status).toBe(200);
        auditBarrier.release();

        const after = await auditScope();
        expect(after.status).toBe(200);
        expect(md010Count(await after.json())).toBe(0);

        const firstRes = await first;
        expect(firstRes.status).toBe(409);
        const problem = (await firstRes.json()) as { type?: string };
        expect(problem.type).toBe('urn:ok:error:audit-superseded');
      } finally {
        auditBarrier?.dispose();
        rmSync(folder, { recursive: true, force: true });
        rmSync(nativeFile, { force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an in-flight audit is superseded when the committed project config changes',
    async () => {
      const folder = join(server.contentDir, SCOPE);
      const configPath = join(server.contentDir, '.ok', 'config.yml');
      seedTabbedCorpus(folder);
      writeFileSync(join(folder, 'log.md'), '# Log\n\n[[missing-history-target]]\n', 'utf-8');

      const ydoc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${server.port}/collab`,
        name: CONFIG_DOC_NAME_PROJECT,
        document: ydoc,
        connect: true,
      });
      const binding = bindConfigDoc(provider, 'project');
      let auditBarrier: AuditBarrier | undefined;

      try {
        await pollUntil(
          () => binding.hasSynced(),
          10_000,
          100,
          'the project config provider to sync',
        );
        await awaitBacklinkIndexed(server, 'missing-history-target', `${SCOPE}/log`);

        const before = await fetch(api(`/api/audit?path=${SCOPE}%2Flog.md`));
        expect(before.status).toBe(200);
        const beforeBody = ValidationAuditResponseSchema.parse(await before.json());
        expect(beforeBody.brokenLinkSuppression).toEqual({
          reason: 'reserved-log-policy',
          count: 1,
        });
        expect(
          beforeBody.files.flatMap((file) => file.diagnostics).some((d) => d.code === 'dead-link'),
        ).toBe(false);

        auditBarrier = pauseAuditAtDocument(`${SCOPE}/doc-1.md`);
        const first = auditScope();
        await auditBarrier.waitUntilStarted();

        const patch = binding.patch({ validation: { suppressLogLinkAdvisories: false } });
        expect(patch.ok).toBe(true);
        await pollUntil(
          () => /suppressLogLinkAdvisories:\s*false/.test(readFileSync(configPath, 'utf-8')),
          15_000,
          25,
          'the project config change to reach disk',
        );
        auditBarrier.release();

        const firstRes = await first;
        expect(firstRes.status).toBe(409);
        const problem = (await firstRes.json()) as { type?: string };
        expect(problem.type).toBe('urn:ok:error:audit-superseded');

        let after: Response | undefined;
        await pollUntil(
          async () => {
            const candidate = await auditScope();
            if (candidate.status === 200) {
              after = candidate;
              return true;
            }
            expect(candidate.status).toBe(409);
            return false;
          },
          15_000,
          100,
          'the post-config audit generation to stabilize',
        );
        expect(after).toBeDefined();
        const afterBody = ValidationAuditResponseSchema.parse(await after?.json());
        expect(md010Count(afterBody)).toBeGreaterThan(0);
        expect(afterBody.brokenLinkSuppression).toBeUndefined();
        expect(
          afterBody.files
            .find((file) => file.file === `${SCOPE}/log.md`)
            ?.diagnostics.some((diagnostic) => diagnostic.code === 'dead-link'),
        ).toBe(true);
      } finally {
        auditBarrier?.dispose();
        binding.dispose();
        provider.destroy();
        ydoc.destroy();
        rmSync(folder, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an in-flight audit is superseded when a frontmatter schema write changes its results',
    async () => {
      const scope = `${SCOPE}/frontmatter`;
      const folder = join(server.contentDir, scope);
      const schemaPath = join(server.contentDir, '.ok', 'schemas', 'audit-epoch.schema.json');
      seedTabbedCorpus(folder);
      mkdirSync(join(server.contentDir, '.ok', 'schemas'), { recursive: true });
      writeFileSync(schemaPath, JSON.stringify({ type: 'object', properties: {} }), 'utf-8');
      const auditBarrier = pauseAuditAtDocument(`${scope}/doc-1.md`);
      try {
        const first = auditScope(scope);
        await auditBarrier.waitUntilStarted();
        const write = await fetch(api('/api/lint/frontmatter-schema'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: '.ok/schemas/audit-epoch.schema.json',
            field: 'owner',
            constraint: { type: 'string', required: true },
          }),
        });
        expect(write.status).toBe(200);
        auditBarrier.release();

        const firstRes = await first;
        expect(firstRes.status).toBe(409);
        const problem = (await firstRes.json()) as { type?: string };
        expect(problem.type).toBe('urn:ok:error:audit-superseded');

        const after = await auditScope(scope);
        expect(after.status).toBe(200);
        const afterBody = ValidationAuditResponseSchema.parse(await after.json());
        expect(
          afterBody.files
            .flatMap((file) => file.diagnostics)
            .some(
              (diagnostic) =>
                diagnostic.source === 'frontmatter' &&
                diagnostic.code === 'required' &&
                diagnostic.message.includes('owner'),
            ),
        ).toBe(true);
      } finally {
        auditBarrier.dispose();
        rmSync(folder, { recursive: true, force: true });
        rmSync(schemaPath, { force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'refused and failed config writes do not supersede an in-flight audit',
    async () => {
      const scope = `${SCOPE}/rejected`;
      const folder = join(server.contentDir, scope);
      const executableConfig = join(server.contentDir, '.markdownlint.cjs');
      const brokenConfig = join(server.contentDir, '.markdownlint.json');
      const blockedSchemaParent = join(server.contentDir, 'blocked-schema-parent');
      seedTabbedCorpus(folder);
      const auditBarrier = pauseAuditAtDocument(`${scope}/doc-1.md`);
      try {
        const first = auditScope(scope);
        await auditBarrier.waitUntilStarted();
        writeFileSync(executableConfig, 'module.exports = { MD012: false };\n', 'utf-8');
        const declined = await fetch(api('/api/lint/markdownlint-config'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ruleId: 'MD012', value: false }),
        });
        expect(declined.status).toBe(409);

        const refused = await fetch(api('/api/lint/frontmatter-schema'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: '../escape.schema.json' }),
        });
        expect(refused.status).toBe(409);

        rmSync(executableConfig, { force: true });
        mkdirSync(brokenConfig);
        const failedMarkdown = await fetch(api('/api/lint/markdownlint-config'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ruleId: 'MD012', value: false }),
        });
        expect(failedMarkdown.status).toBe(500);

        writeFileSync(blockedSchemaParent, 'not a directory', 'utf-8');
        const failedFrontmatter = await fetch(api('/api/lint/frontmatter-schema'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: 'blocked-schema-parent/failure.schema.json' }),
        });
        expect(failedFrontmatter.status).toBe(500);
        auditBarrier.release();

        const firstRes = await first;
        expect(firstRes.status).toBe(200);
      } finally {
        auditBarrier.dispose();
        rmSync(folder, { recursive: true, force: true });
        rmSync(executableConfig, { force: true });
        rmSync(brokenConfig, { recursive: true, force: true });
        rmSync(blockedSchemaParent, { force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
