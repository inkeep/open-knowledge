/**
 * The audit surface (`GET /api/audit`) against a branch switch that lands while
 * a walk is in flight.
 *
 * A switch replaces the content set wholesale on disk while moving nothing in
 * the lint configuration, so the audit's coalescing key only moves if it
 * carries the active branch alongside the lint-config epoch. Without the branch
 * dimension an audit issued after the switch computes an identical key,
 * attaches to the walk started before it, and is served the previous branch's
 * plane — and the pre-switch walk itself publishes a plane whose early docs are
 * the old branch's bytes and whose later docs are the new branch's.
 *
 * The switch is driven through the server's own branch state
 * (`switchReconciledBaseScope`, the call the HEAD watcher makes) paired with the
 * disk-side content swap, rather than through real git: the harness boots with
 * `gitEnabled: false`, so no HEAD watcher exists to observe a checkout.
 *
 * Own server (not the shared one in `audit-http.test.ts`): the corpus is
 * rewritten in place mid-test, which any other test sharing the tree would see.
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

const SCOPE = 'audit-branch';

/**
 * Sized so the whole-scope walk runs about a second — long enough that the
 * switch lands mid-walk, and few enough files that seeding and file-watcher
 * indexing stay cheap. In the pre-switch corpus every line carries a hard tab,
 * so MD010 separates the two branches' content.
 */
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
        // The tabs are live to begin with, so a post-switch plane that still
        // carries MD010 is a stale answer and not a mis-seeded fixture. Scoped
        // to one doc on purpose: a whole-scope pre-check would warm the audit's
        // per-file cache and leave the walk below too short to still be running
        // when the switch lands.
        const before = await fetch(api(`/api/audit?path=${SCOPE}%2Fdoc-0.md`));
        expect(before.status).toBe(200);
        expect(parseAudit(await before.json()).md010).toBeGreaterThan(0);

        let firstSettled = false;
        const first = auditScope().then((res) => {
          firstSettled = true;
          return res;
        });

        // A real round-trip the server can only answer once the walk has
        // yielded — the interleave point, with no sleep.
        expect((await fetch(api('/api/lint/config'))).status).toBe(200);

        // The two halves of a checkout, in the order git performs them: the
        // working tree is swapped, then the server's branch state follows.
        writeCorpus(folder, ' ');
        const { durabilityState } = server.instance;
        expect(durabilityState.getActiveBranch()).not.toBe('audit-branch-target');
        durabilityState.switchReconciledBaseScope('audit-branch-target');

        // The property under test only exists while the earlier walk is still
        // running; a failure here means the corpus stopped being big enough,
        // not that the behavior changed.
        expect(firstSettled).toBe(false);

        const after = await auditScope();
        expect(after.status).toBe(200);
        const afterPlane = parseAudit(await after.json());
        // A walk that found nothing would also report zero MD010 — pin that it
        // actually re-read the scope.
        expect(afterPlane.fileCount).toBe(DOC_COUNT);
        expect(afterPlane.md010).toBe(0);

        // The superseded walk reports no plane rather than a mixed one: its
        // early docs read the pre-switch bytes and its later docs would not
        // have.
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
