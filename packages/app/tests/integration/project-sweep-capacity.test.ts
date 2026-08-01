/**
 * Integration coverage for the project-scope "Fix all" sweep under agent-session
 * capacity pressure. Drives the REAL client sweep (`runProjectFixSweep` +
 * `fixLintDoc`) against a REAL server whose shared `AgentSessionManager` is
 * capped small, so the retry/pacing path meets the actual 503 the server emits —
 * a fidelity no unit test reaches, since the refusal, its retry, and the
 * eviction that lets the retry win all live across the client/server boundary.
 *
 * Two behaviours are pinned:
 *   1. The server genuinely refuses a new session at the cap with the retryable
 *      capacity problem (deterministic — no eviction during the window).
 *   2. A full sweep under a low cap fixes every file with zero capacity
 *      failures, while a concurrent agent write to its own doc keeps succeeding
 *      throughout — the shared session budget must not starve a live writer.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CAPACITY_PROBLEM_TYPE,
  isCapacityRefusal,
  runProjectFixSweep,
  type SweepFixOutcome,
  sweepSleep,
} from '@/components/problems-sweep';
import { fixLintDoc } from '@/editor/lint-config-client';
import { agentWriteMd, createTestServer, type TestServer } from './test-harness';

type FetchFn = typeof globalThis.fetch;

// A hard tab trips MD010, which markdownlint auto-fixes — so every seeded doc is
// genuinely fixable and a successful sweep leaves zero failures.
const FIXABLE_BODY = '# Doc\n\n\tindented with a hard tab\n';

let server: TestServer | undefined;
let restoreFetch: (() => void) | undefined;

afterEach(async () => {
  restoreFetch?.();
  restoreFetch = undefined;
  await server?.cleanup();
  server = undefined;
});

/** Seed a fixable markdown doc on disk; the fix path loads it from disk via a
 *  session, so no file-watcher round trip is needed before fixing. */
function seedFixableDoc(contentDir: string, docName: string): void {
  const filePath = join(contentDir, `${docName}.md`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, FIXABLE_BODY, 'utf-8');
}

/** Rewrite the client's origin-relative `/api/...` calls to the test server, so
 *  the real `fixLintDoc` (which posts to a relative path in the browser) reaches
 *  this server. Absolute URLs (harness helpers) pass through untouched. */
function installFetchShim(baseUrl: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const target = typeof input === 'string' && input.startsWith('/') ? baseUrl + input : input;
    return original(target, init);
  }) as FetchFn;
  return () => {
    globalThis.fetch = original;
  };
}

describe('project-scope Fix all under agent-session capacity', () => {
  test('the server refuses a new session at the cap with the retryable capacity problem', async () => {
    // A long idle floor means the two saturating sessions never become
    // evictable during the test, so the third request has no slot and MUST be
    // refused — the refusal is structural, not a timing race.
    server = await createTestServer({
      markdownlintEnabled: true,
      agentSessionOptions: { maxSessions: 2, minEvictableIdleMs: 60_000 },
    });
    const { baseUrl, contentDir } = server;

    for (const n of [0, 1, 2]) seedFixableDoc(contentDir, `capacity-refusal/doc-${n}`);

    const postFix = (docName: string): Promise<Response> =>
      fetch(`${baseUrl}/api/lint/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName }),
      });

    // Fill the two-session budget. Distinct docs => distinct sessions that
    // persist after the fix. Both succeed (a passing fix here would fail the
    // whole test if a stray session had already consumed a slot).
    expect((await postFix('capacity-refusal/doc-0')).status).toBe(200);
    expect((await postFix('capacity-refusal/doc-1')).status).toBe(200);

    // The third needs a third session; none can be evicted, so it is refused.
    const refused = await postFix('capacity-refusal/doc-2');
    expect(refused.status).toBe(503);
    expect(refused.headers.get('Retry-After')).toBe('10');
    const body = (await refused.json()) as { type?: unknown };
    expect(body.type).toBe(CAPACITY_PROBLEM_TYPE);

    // The refusal is exactly what the sweep's retry predicate keys on.
    expect(
      isCapacityRefusal({
        status: refused.status,
        problemType: typeof body.type === 'string' ? body.type : null,
      }),
    ).toBe(true);
  }, 30_000);

  test('a full sweep fixes every file with zero capacity failures while a concurrent agent write survives', async () => {
    // Cap = 2 with a moderate idle floor. The concurrent writer holds one slot
    // with a warm (reused) session, leaving the sweep a single slot it must
    // recycle by eviction — so most sweep files hit a real 503 and rely on the
    // retry, while the floor (well above an in-process fix round trip) keeps
    // the just-used session un-evictable long enough that the refusal is real.
    server = await createTestServer({
      markdownlintEnabled: true,
      agentSessionOptions: { maxSessions: 2, minEvictableIdleMs: 700 },
    });
    const { port, contentDir } = server;
    restoreFetch = installFetchShim(server.baseUrl);

    const sweepDocs = [0, 1, 2, 3].map((n) => `capacity-sweep/doc-${n}`);
    for (const docName of sweepDocs) seedFixableDoc(contentDir, docName);

    // The collateral writer keeps writing to its own doc under a stable agent
    // id, so after its first write it reuses one warm session (a reused
    // session skips the capacity gate) and, writing far more often than the
    // idle floor, is never the evictable LRU entry.
    const COLLATERAL_DOC = 'capacity-collateral/agent-doc';
    const WRITER_INTERVAL_MS = 50;
    const writeCollateral = (): Promise<void> =>
      agentWriteMd(port, 'concurrent agent line\n', {
        docName: COLLATERAL_DOC,
        position: 'append',
        agentId: 'collateral-writer',
        agentName: 'Collateral',
      });

    // Establish the warm session before the sweep begins to apply pressure.
    await writeCollateral();

    let sweepDone = false;
    let collateralWrites = 0;
    const collateralFailures: Array<{ status: number | null }> = [];
    const runWriterLoop = async (): Promise<void> => {
      while (!sweepDone) {
        await sweepSleep(WRITER_INTERVAL_MS);
        if (sweepDone) break;
        try {
          await writeCollateral();
          collateralWrites += 1;
        } catch (err) {
          // A real HTTP non-OK surfaces here (harness sets err.status). A
          // capacity 503 would mean the sweep starved the writer.
          collateralFailures.push({ status: (err as { status?: number }).status ?? null });
        }
      }
    };

    let capacityRefusals = 0;
    const fixItem = async (docName: string): Promise<SweepFixOutcome> => {
      const outcome = await fixLintDoc(docName);
      if (!outcome.ok && isCapacityRefusal(outcome)) capacityRefusals += 1;
      return outcome;
    };

    const writerPromise = runWriterLoop();
    const result = await runProjectFixSweep({
      items: sweepDocs,
      fixItem,
      sleep: sweepSleep,
      onProgress: () => {},
      shouldContinue: () => true,
    });
    sweepDone = true;
    await writerPromise;

    // Every file was fixed — no file was recorded unfixable for any reason,
    // capacity or otherwise.
    expect(result.cancelled).toBe(false);
    expect(result.failures).toEqual([]);

    // The retry path actually engaged against a real refusal — the test is not
    // vacuously green because the cap was never reached.
    expect(capacityRefusals).toBeGreaterThan(0);

    // The concurrent writer wrote throughout and was never refused.
    expect(collateralWrites).toBeGreaterThan(0);
    expect(collateralFailures).toEqual([]);
  }, 30_000);
});
