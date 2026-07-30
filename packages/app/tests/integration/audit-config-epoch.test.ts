/**
 * The audit surface (`GET /api/audit`) against a rule toggle that lands while a
 * walk is in flight.
 *
 * A native markdownlint rule write moves no base-config fingerprint — the rules
 * come from the `.markdownlint.*` cascade — so the audit's coalescing key only
 * moves if it carries a lint-config epoch. Without one, an audit issued after
 * the toggle attaches to the walk started before it and is served counts
 * computed under the rules the user just changed.
 *
 * Own server (not the shared one in `audit-http.test.ts`): the rule write puts
 * a governing `.markdownlint.json` at the content root, which replaces the
 * project's rules for every doc in the tree while it exists.
 */

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

const SCOPE = 'audit-epoch';

/**
 * Sized so the whole-scope walk runs about a second — long enough that a rule
 * write issued right after the walk starts is serviced mid-walk, and few enough
 * files that seeding and file-watcher indexing stay cheap. Every line carries a
 * hard tab, so MD010 is the rule under test.
 */
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

async function auditScope(): Promise<Response> {
  return fetch(api(`/api/audit?path=${SCOPE}`));
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
      try {
        // The rule is live to begin with, so a post-toggle plane that still
        // carries MD010 is a stale answer and not a mis-seeded fixture. Scoped
        // to one doc on purpose: a whole-scope pre-check would warm the audit's
        // per-file cache and leave the walk below too short to still be running
        // when the rule write lands.
        const before = await fetch(api(`/api/audit?path=${SCOPE}%2Fdoc-0.md`));
        expect(before.status).toBe(200);
        expect(md010Count(await before.json())).toBeGreaterThan(0);

        let firstSettled = false;
        const first = auditScope().then((res) => {
          firstSettled = true;
          return res;
        });

        // Serviced mid-walk — which is only possible because the walk yields.
        // No sleep: awaiting this response IS the interleave point.
        const write = await fetch(api('/api/lint/markdownlint-config'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ruleId: 'MD010', value: false }),
        });
        expect(write.status).toBe(200);
        // The property under test only exists while the earlier walk is still
        // running; a failure here means the corpus stopped being big enough,
        // not that the behavior changed.
        expect(firstSettled).toBe(false);

        const after = await auditScope();
        expect(after.status).toBe(200);
        expect(md010Count(await after.json())).toBe(0);

        // The superseded walk reports no plane rather than a mixed one: its
        // early docs saw MD010 enabled and its later docs would not have.
        const firstRes = await first;
        expect(firstRes.status).toBe(409);
        const problem = (await firstRes.json()) as { type?: string };
        expect(problem.type).toBe('urn:ok:error:audit-superseded');
      } finally {
        rmSync(folder, { recursive: true, force: true });
        rmSync(nativeFile, { force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
