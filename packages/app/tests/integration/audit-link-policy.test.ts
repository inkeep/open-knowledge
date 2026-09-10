import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationAuditResponseSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { awaitBacklinkIndexed, createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;

const BASE_CONFIG_YML = 'contentRules:\n  markdownlint:\n    enabled: true\n';
const POLICY_OFF_CONFIG_YML = `${BASE_CONFIG_YML}validation:\n  suppressLogLinkAdvisories: false\n`;
const POLICY_ON_CONFIG_YML = `${BASE_CONFIG_YML}validation:\n  suppressLogLinkAdvisories: true\n`;

beforeAll(async () => {
  server = await createTestServer({ seedProjectConfigYml: BASE_CONFIG_YML });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const SCOPE = 'audit-log-policy';

const GHOST_TARGET = 'audit-log-policy-ghost';

const TEST_TIMEOUT_MS = 60_000;

function api(pathAndQuery: string): string {
  return `http://127.0.0.1:${server.port}${pathAndQuery}`;
}

async function deadLinkFiles(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ValidationAuditResponseSchema.parse(await res.json())
    .files.filter((f) => f.diagnostics.some((d) => d.code === 'dead-link'))
    .map((f) => f.file);
}

async function auditScope(): Promise<string[]> {
  return deadLinkFiles(await fetch(api(`/api/audit?path=${SCOPE}`)));
}

async function auditDoc(docName: string): Promise<string[]> {
  return deadLinkFiles(await fetch(api(`/api/audit?doc=${encodeURIComponent(docName)}`)));
}

describe('GET /api/audit under the reserved-log advisory policy', () => {
  test(
    'the reserved log is suppressed by default and returns live when the policy is switched off',
    async () => {
      const folder = join(server.contentDir, SCOPE);
      const configPath = join(server.contentDir, '.ok', 'config.yml');
      const wikiLink = `# Doc\n\nSee [[${GHOST_TARGET}]].\n`;
      mkdirSync(join(folder, 'upper'), { recursive: true });
      writeFileSync(join(folder, 'log.md'), wikiLink, 'utf-8');
      writeFileSync(join(folder, 'journal.md'), wikiLink, 'utf-8');
      writeFileSync(join(folder, 'upper', 'LOG.md'), wikiLink, 'utf-8');
      try {
        for (const source of ['log', 'journal', 'upper/LOG']) {
          await awaitBacklinkIndexed(server, GHOST_TARGET, `${SCOPE}/${source}`);
        }

        expect(await auditScope()).toEqual([`${SCOPE}/journal.md`, `${SCOPE}/upper/LOG.md`]);

        writeFileSync(configPath, POLICY_OFF_CONFIG_YML, 'utf-8');
        expect(await auditScope()).toEqual([
          `${SCOPE}/journal.md`,
          `${SCOPE}/log.md`,
          `${SCOPE}/upper/LOG.md`,
        ]);

        writeFileSync(configPath, POLICY_ON_CONFIG_YML, 'utf-8');
        expect(await auditScope()).toEqual([`${SCOPE}/journal.md`, `${SCOPE}/upper/LOG.md`]);

        expect(await auditDoc(`${SCOPE}/log`)).toEqual([]);
        writeFileSync(configPath, POLICY_OFF_CONFIG_YML, 'utf-8');
        expect(await auditDoc(`${SCOPE}/log`)).toEqual([`${SCOPE}/log.md`]);
      } finally {
        rmSync(folder, { recursive: true, force: true });
        writeFileSync(configPath, BASE_CONFIG_YML, 'utf-8');
      }
    },
    TEST_TIMEOUT_MS,
  );
});
