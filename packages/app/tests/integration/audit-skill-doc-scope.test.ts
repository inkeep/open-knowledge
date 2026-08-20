/**
 * Skill-bundle scoping for the unified validation plane (`GET /api/audit`),
 * against a real server boot. The end-to-end case: a skill bundle whose
 * relative links name artifacts it only creates at runtime, admitted by the
 * boot-time in-place scan, projects no diagnostics, while an ordinary doc's
 * findings survive. The gate's contract lives on `isProblemsPlaneExcludedDoc`
 * (server `cc1-broadcast.ts`), whose closed-table unit test pins every name
 * shape, including the dot-dir docs that deliberately keep their findings.
 */

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
  // Pre-create the contentDir so the boot-time in-place skill scan admits the
  // bundle without depending on live re-scan timing.
  contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-skill-scope-')));
  const skillDir = join(contentDir, '.claude', 'skills', 'record-a-decision');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf-8');
  // Control doc: an ordinary content doc with a dead link that SHOULD appear.
  writeFileSync(
    join(contentDir, 'control.md'),
    '# Control\n\n\ttabbed line for MD010\n\nSee [[audit-skill-scope-ghost]].\n',
    'utf-8',
  );
  // The harness only seeds config for fresh contentDirs; this dir is
  // caller-owned, so seed markdownlint enablement directly.
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

// Outer budget exceeds awaitBacklinkIndexed's inner timeout so the helper's
// targeted error surfaces before the runner's generic timeout.
const BACKLINK_SEED_TIMEOUT_MS = 45_000;

describe('GET /api/audit — skill documents in the project problems plane', () => {
  test(
    'skill bundle docs surface no diagnostics in the project audit plane',
    async () => {
      // Wait for the control doc's dead link so the plane is provably seeded.
      await awaitBacklinkIndexed(server, 'audit-skill-scope-ghost', 'control');
      // Precondition: the skill doc IS an admitted link-index source — proven
      // by its own edge into the control doc — so the emptiness assertions
      // below cannot pass vacuously. A silently de-admitted bundle would
      // satisfy them while breaking the backlinks-keep-their-edges promise.
      await awaitBacklinkIndexed(server, 'control', '.claude/skills/record-a-decision/SKILL');

      const res = await fetch(`http://127.0.0.1:${server.port}/api/audit`);
      expect(res.status).toBe(200);
      const body: ValidationAuditResponse = ValidationAuditResponseSchema.parse(await res.json());

      // Control: the ordinary doc's dead link AND lint finding ARE reported —
      // the scope gate must not overshoot into suppressing real findings.
      const control = body.files.find((f) => f.file === 'control.md');
      expect(control?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);
      expect(control?.diagnostics.some((d) => d.code === 'MD010')).toBe(true);

      // The invariant: no rows of ANY source on the skill doc. The link half is
      // what this gate carries; the MD010-triggering tab pins that the two
      // validators agree on scope, since the walk's own hidden-segment skip
      // (not this gate) is what keeps markdownlint off these paths. The exact
      // file set also catches the gate over-reaching onto other docs.
      expect(body.files.map((f) => f.file)).toEqual(['control.md']);
    },
    BACKLINK_SEED_TIMEOUT_MS,
  );
});
