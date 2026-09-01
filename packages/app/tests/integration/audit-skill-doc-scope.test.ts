import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ValidationAuditResponse,
  ValidationAuditResponseSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { awaitBacklinkIndexed, createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;
let contentDir: string;

const SKILL_MD = `---
name: record-a-decision
description: Skill bundle whose relative links name runtime artifacts.
---

# Record a decision

\tThis hard-tab line trips MD010 when markdownlint runs on this file.

Runtime artifact link: [example decision](decisions/0007-use-rest-api.md)

Also see [[control]].
`;

beforeAll(async () => {
  contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-skill-scope-')));
  const skillDir = join(contentDir, '.claude', 'skills', 'record-a-decision');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf-8');
  writeFileSync(
    join(contentDir, 'control.md'),
    '# Control\n\n\ttabbed line for MD010\n\nSee [[audit-skill-scope-ghost]].\n',
    'utf-8',
  );
  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(
    join(contentDir, '.ok', 'config.yml'),
    'contentRules:\n  markdownlint:\n    enabled: true\n',
    'utf-8',
  );
  server = await createTestServer({ contentDir });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
  rmSync(contentDir, { recursive: true, force: true });
});

const BACKLINK_SEED_TIMEOUT_MS = 45_000;

describe('GET /api/audit — skill documents in the project problems plane', () => {
  test(
    'skill bundle docs surface no diagnostics in the project audit plane',
    async () => {
      await awaitBacklinkIndexed(server, 'audit-skill-scope-ghost', 'control');
      await awaitBacklinkIndexed(server, 'control', '.claude/skills/record-a-decision/SKILL');

      const res = await fetch(`http://127.0.0.1:${server.port}/api/audit`);
      expect(res.status).toBe(200);
      const body: ValidationAuditResponse = ValidationAuditResponseSchema.parse(await res.json());

      const control = body.files.find((f) => f.file === 'control.md');
      expect(control?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);
      expect(control?.diagnostics.some((d) => d.code === 'MD010')).toBe(true);

      expect(body.files.map((f) => f.file)).toEqual(['control.md']);
    },
    BACKLINK_SEED_TIMEOUT_MS,
  );
});
