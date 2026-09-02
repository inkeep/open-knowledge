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

const FIXABLE_BODY = '# Doc\n\n\tindented with a hard tab\n';

let server: TestServer | undefined;
let restoreFetch: (() => void) | undefined;

afterEach(async () => {
  restoreFetch?.();
  restoreFetch = undefined;
  await server?.cleanup();
  server = undefined;
});

function seedFixableDoc(contentDir: string, docName: string): void {
  const filePath = join(contentDir, `${docName}.md`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, FIXABLE_BODY, 'utf-8');
}

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

    expect((await postFix('capacity-refusal/doc-0')).status).toBe(200);
    expect((await postFix('capacity-refusal/doc-1')).status).toBe(200);

    const refused = await postFix('capacity-refusal/doc-2');
    expect(refused.status).toBe(503);
    expect(refused.headers.get('Retry-After')).toBe('10');
    const body = (await refused.json()) as { type?: unknown };
    expect(body.type).toBe(CAPACITY_PROBLEM_TYPE);

    expect(
      isCapacityRefusal({
        status: refused.status,
        problemType: typeof body.type === 'string' ? body.type : null,
      }),
    ).toBe(true);
  }, 30_000);

  test('a full sweep fixes every file with zero capacity failures while a concurrent agent write survives', async () => {
    server = await createTestServer({
      markdownlintEnabled: true,
      agentSessionOptions: { maxSessions: 2, minEvictableIdleMs: 700 },
    });
    const { port, contentDir } = server;
    restoreFetch = installFetchShim(server.baseUrl);

    const sweepDocs = [0, 1, 2, 3].map((n) => `capacity-sweep/doc-${n}`);
    for (const docName of sweepDocs) seedFixableDoc(contentDir, docName);

    const COLLATERAL_DOC = 'capacity-collateral/agent-doc';
    const WRITER_INTERVAL_MS = 50;
    const writeCollateral = (): Promise<void> =>
      agentWriteMd(port, 'concurrent agent line\n', {
        docName: COLLATERAL_DOC,
        position: 'append',
        agentId: 'collateral-writer',
        agentName: 'Collateral',
      });

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

    expect(result.cancelled).toBe(false);
    expect(result.failures).toEqual([]);

    expect(capacityRefusals).toBeGreaterThan(0);

    expect(collateralWrites).toBeGreaterThan(0);
    expect(collateralFailures).toEqual([]);
  }, 30_000);
});
