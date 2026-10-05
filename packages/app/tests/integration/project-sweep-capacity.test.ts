import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CAPACITY_PROBLEM_TYPE,
  isCapacityRefusal,
  runProjectFixSweep,
  type SweepFixOutcome,
  sweepSleep,
} from '@/components/problems-sweep';
import { fixLintDoc } from '@/editor/lint-config-client';
import * as agentSessions from '../../../server/src/agent-sessions';
import * as lintAudit from '../../../server/src/lint/audit';
import { createTestServer, type TestServer } from './test-harness';

type FetchFn = typeof globalThis.fetch;

const FIXABLE_BODY = '# Doc\n\n\tindented with a hard tab\n';

let server: TestServer | undefined;
let restoreFetch: (() => void) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  restoreFetch?.();
  restoreFetch = undefined;
  await server?.cleanup();
  server = undefined;
});

describe('agent-session operation lifetime', () => {
  const startCappedServer = async (minEvictableIdleMs: number) => {
    server = await createTestServer({
      markdownlintEnabled: true,
      agentSessionOptions: { maxSessions: 2, minEvictableIdleMs },
    });
    const { baseUrl, contentDir, instance } = server;
    const post = (route: string, body: object): Promise<Response> =>
      fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    return {
      contentDir,
      sessionManager: instance.sessionManager,
      debouncer: instance.hocuspocus.debouncer,
      post,
    };
  };

  const freezeClock = () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    return (ms: number): void => {
      clock += ms;
    };
  };

  test.each([
    { label: 'markdown write below the idle floor', kind: 'markdown', floor: 700, advance: 0 },
    { label: 'markdown write past the idle floor', kind: 'markdown', floor: 700, advance: 701 },
    {
      label: 'markdown write past the default floor',
      kind: 'markdown',
      floor: agentSessions.MIN_EVICTABLE_IDLE_MS,
      advance: agentSessions.MIN_EVICTABLE_IDLE_MS + 1,
    },
    { label: 'frontmatter patch', kind: 'frontmatter', floor: 700, advance: 701 },
    { label: 'text patch', kind: 'patch', floor: 700, advance: 701 },
    { label: 'lint fix', kind: 'lint', floor: 700, advance: 701 },
    { label: 'batched markdown write', kind: 'batch', floor: 700, advance: 701 },
  ] as const)(
    'an accepted $label retains its session across capacity admission',
    async ({ kind, floor, advance }) => {
      const { contentDir, sessionManager, post } = await startCappedServer(floor);
      const docPrefix = `session-lifetime-${randomUUID()}`;
      const writerDoc = `${docPrefix}/writer`;
      const [firstDoc, nextDoc] = [`${docPrefix}/first`, `${docPrefix}/next`];
      for (const docName of [firstDoc, nextDoc]) seedFixableDoc(contentDir, docName);
      const identity = { agentId: 'held-writer', agentName: 'Held writer' };
      const advanceClock = freezeClock();
      expect(
        (
          await post('/api/agent-write-md', {
            ...identity,
            docName: writerDoc,
            markdown: FIXABLE_BODY,
            position: 'replace',
          })
        ).status,
      ).toBe(200);

      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const prepareMarkdown = agentSessions.prepareAgentMarkdownParse;
      const prepareFrontmatter = agentSessions.prepareFrontmatterPatchParse;
      const lintAndFix = lintAudit.lintAndFixSource;
      vi.spyOn(agentSessions, 'prepareAgentMarkdownParse').mockImplementation(async (...args) => {
        const parsed = await prepareMarkdown(...args);
        if (args[0].name === writerDoc) {
          entered.resolve();
          await release.promise;
        }
        return parsed;
      });
      vi.spyOn(agentSessions, 'prepareFrontmatterPatchParse').mockImplementation(
        async (...args) => {
          const parsed = await prepareFrontmatter(...args);
          if (args[0].name === writerDoc) {
            entered.resolve();
            await release.promise;
          }
          return parsed;
        },
      );
      vi.spyOn(lintAudit, 'lintAndFixSource').mockImplementation(async (...args) => {
        const fixed = await lintAndFix(...args);
        if (args[0].docRelPath === `${writerDoc}.md`) {
          entered.resolve();
          await release.promise;
        }
        return fixed;
      });
      const requests = {
        markdown: {
          route: '/api/agent-write-md',
          body: { ...identity, docName: writerDoc, markdown: 'After\n', position: 'append' },
        },
        frontmatter: {
          route: '/api/frontmatter-patch',
          body: { ...identity, docName: writerDoc, patch: { title: 'Updated title' } },
        },
        patch: {
          route: '/api/agent-patch',
          body: { ...identity, docName: writerDoc, find: '# Doc', replace: '# Updated doc' },
        },
        lint: { route: '/api/lint/fix', body: { ...identity, docName: writerDoc } },
        batch: {
          route: '/api/agent-write-batch',
          body: {
            ...identity,
            docs: [{ docName: writerDoc, markdown: 'After\n', position: 'append' }],
          },
        },
      };
      const request = requests[kind];
      const writing = post(request.route, request.body);
      try {
        await Promise.race([
          entered.promise,
          writing.then((response) => {
            throw new Error(`Operation returned before its barrier: ${response.status}`);
          }),
        ]);
        expect((await post('/api/lint/fix', { docName: firstDoc })).status).toBe(200);
        advanceClock(advance);
        const admission = await post('/api/lint/fix', { docName: nextDoc });
        expect(admission.status).toBe(advance === 0 ? 503 : 200);
        expect.soft(sessionManager.hasSession(writerDoc, 'agent-held-writer')).toBe(true);
        expect(sessionManager.liveSessionCount).toBe(2);
        release.resolve();
        const response = await writing;
        expect(response.status).toBe(200);
        if (kind === 'batch') {
          expect(await response.json()).toMatchObject({
            written: 1,
            failed: 0,
            results: [{ docName: writerDoc, status: 'written' }],
          });
        }
        advanceClock(floor + 1);
        for (const suffix of ['released-first', 'released-next']) {
          const docName = `${docPrefix}/${suffix}`;
          seedFixableDoc(contentDir, docName);
          expect((await post('/api/lint/fix', { docName })).status).toBe(200);
        }
        expect(sessionManager.hasSession(writerDoc, 'agent-held-writer')).toBe(false);
        expect(sessionManager.liveSessionCount).toBe(2);
      } finally {
        release.resolve();
        await writing;
      }
    },
  );

  test('an accepted batched markdown write retains its session while its write is flushed', async () => {
    const { contentDir, sessionManager, debouncer, post } = await startCappedServer(700);
    const docPrefix = `session-batch-flush-${randomUUID()}`;
    const writerDoc = `${docPrefix}/writer`;
    const [firstDoc, nextDoc] = [`${docPrefix}/first`, `${docPrefix}/next`];
    for (const docName of [firstDoc, nextDoc]) seedFixableDoc(contentDir, docName);
    const advanceClock = freezeClock();
    expect(
      (
        await post('/api/agent-write-md', {
          agentId: 'flushed-writer',
          docName: writerDoc,
          markdown: '# Doc\n',
          position: 'replace',
        })
      ).status,
    ).toBe(200);
    const flushing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const executeNow = debouncer.executeNow;
    vi.spyOn(debouncer, 'executeNow').mockImplementation(async (id: string) => {
      const stored = await executeNow(id);
      if (id === `onStoreDocument-${writerDoc}`) {
        flushing.resolve();
        await release.promise;
      }
      return stored;
    });
    const writing = post('/api/agent-write-batch', {
      agentId: 'flushed-writer',
      docs: [{ docName: writerDoc, markdown: 'After\n', position: 'append' }],
    });
    try {
      await Promise.race([
        flushing.promise,
        writing.then((response) => {
          throw new Error(`Batch returned before its flush barrier: ${response.status}`);
        }),
      ]);
      expect((await post('/api/lint/fix', { docName: firstDoc })).status).toBe(200);
      advanceClock(701);
      expect((await post('/api/lint/fix', { docName: nextDoc })).status).toBe(200);
      expect.soft(sessionManager.hasSession(writerDoc, 'agent-flushed-writer')).toBe(true);
      expect(sessionManager.liveSessionCount).toBe(2);
      release.resolve();
      const response = await writing;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        written: 1,
        failed: 0,
        results: [{ docName: writerDoc, status: 'written' }],
      });
    } finally {
      release.resolve();
      await writing;
    }
  });

  test('overlapping operations keep the session held until the last operation completes', async () => {
    const { contentDir, sessionManager, post } = await startCappedServer(700);
    const docPrefix = `session-overlap-${randomUUID()}`;
    const writerDoc = `${docPrefix}/writer`;
    const advanceClock = freezeClock();
    expect(
      (
        await post('/api/agent-write-md', {
          agentId: 'overlap-writer',
          docName: writerDoc,
          markdown: '# Doc\n',
          position: 'replace',
        })
      ).status,
    ).toBe(200);
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    const prepare = agentSessions.prepareFrontmatterPatchParse;
    let preparation = 0;
    vi.spyOn(agentSessions, 'prepareFrontmatterPatchParse').mockImplementation(async (...args) => {
      const parsed = await prepare(...args);
      if (args[0].name === writerDoc) {
        preparation += 1;
        if (preparation === 1) {
          firstEntered.resolve();
          await firstRelease.promise;
        } else {
          secondEntered.resolve();
          await secondRelease.promise;
        }
      }
      return parsed;
    });
    const body = { agentId: 'overlap-writer', docName: writerDoc, patch: {} };
    const first = post('/api/frontmatter-patch', body);
    const second = firstEntered.promise.then(() => post('/api/frontmatter-patch', body));
    try {
      await secondEntered.promise;
      firstRelease.resolve();
      expect((await first).status).toBe(200);
      for (const suffix of ['first', 'next', 'last']) {
        const docName = `${docPrefix}/${suffix}`;
        seedFixableDoc(contentDir, docName);
        advanceClock(701);
        expect((await post('/api/lint/fix', { docName })).status).toBe(200);
        expect(sessionManager.liveSessionCount).toBe(2);
      }
      expect.soft(sessionManager.hasSession(writerDoc, 'agent-overlap-writer')).toBe(true);
      secondRelease.resolve();
      expect((await second).status).toBe(200);
      const nextDoc = `${docPrefix}/after-overlap`;
      seedFixableDoc(contentDir, nextDoc);
      advanceClock(701);
      expect((await post('/api/lint/fix', { docName: nextDoc })).status).toBe(200);
      expect(sessionManager.hasSession(writerDoc, 'agent-overlap-writer')).toBe(false);
      expect(sessionManager.liveSessionCount).toBe(2);
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  test('a refused text patch releases its session for later idle reclamation', async () => {
    const { contentDir, sessionManager, post } = await startCappedServer(700);
    const docPrefix = `session-refusal-${randomUUID()}`;
    const writerDoc = `${docPrefix}/writer`;
    const advanceClock = freezeClock();
    const identity = { agentId: 'refused-writer', docName: writerDoc };
    expect(
      (await post('/api/agent-write-md', { ...identity, markdown: '# Doc\n', position: 'replace' }))
        .status,
    ).toBe(200);
    expect(
      (await post('/api/agent-patch', { ...identity, find: 'absent target', replace: 'new text' }))
        .status,
    ).toBe(404);
    const firstDoc = `${docPrefix}/first`;
    seedFixableDoc(contentDir, firstDoc);
    expect((await post('/api/lint/fix', { docName: firstDoc })).status).toBe(200);
    advanceClock(701);
    const nextDoc = `${docPrefix}/next`;
    seedFixableDoc(contentDir, nextDoc);
    expect((await post('/api/lint/fix', { docName: nextDoc })).status).toBe(200);
    expect(sessionManager.hasSession(writerDoc, 'agent-refused-writer')).toBe(false);
    expect(sessionManager.liveSessionCount).toBe(2);
  });

  test('a write refused at capacity leaves its later session reclaimable once idle', async () => {
    const { contentDir, sessionManager, post } = await startCappedServer(700);
    const docPrefix = `session-capacity-refusal-${randomUUID()}`;
    const writerDoc = `${docPrefix}/writer`;
    const advanceClock = freezeClock();
    for (const suffix of ['first', 'second']) {
      const docName = `${docPrefix}/${suffix}`;
      seedFixableDoc(contentDir, docName);
      expect((await post('/api/lint/fix', { docName })).status).toBe(200);
    }
    const write = {
      agentId: 'capacity-writer',
      docName: writerDoc,
      markdown: '# Doc\n',
      position: 'replace',
    };
    expect((await post('/api/agent-write-md', write)).status).toBe(503);
    advanceClock(701);
    expect((await post('/api/agent-write-md', write)).status).toBe(200);
    expect(sessionManager.hasSession(writerDoc, 'agent-capacity-writer')).toBe(true);
    advanceClock(701);
    for (const suffix of ['released-first', 'released-next']) {
      const docName = `${docPrefix}/${suffix}`;
      seedFixableDoc(contentDir, docName);
      expect((await post('/api/lint/fix', { docName })).status).toBe(200);
    }
    expect(sessionManager.hasSession(writerDoc, 'agent-capacity-writer')).toBe(false);
    expect(sessionManager.liveSessionCount).toBe(2);
  });
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
    const conflicts = server.instance.conflicts;
    const raise = conflicts.raise.bind(conflicts);
    let firstConflict:
      | { input: Parameters<typeof raise>[0]; stack: string | undefined }
      | undefined;
    vi.spyOn(conflicts, 'raise').mockImplementation((input) => {
      const trace =
        !firstConflict && input.file === `${COLLATERAL_DOC}.md`
          ? { input, stack: new Error().stack }
          : undefined;
      raise(input);
      if (trace && conflicts.has(COLLATERAL_DOC)) firstConflict = trace;
    });
    const writeCollateral = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown: 'concurrent agent line\n',
          docName: COLLATERAL_DOC,
          position: 'append',
          agentId: 'collateral-writer',
          agentName: 'Collateral',
        }),
      });

    expect((await writeCollateral()).status).toBe(200);

    let sweepDone = false;
    let collateralWrites = 0;
    const collateralFailures: Array<
      { status: number; body: string } | { status: null; error: unknown }
    > = [];
    const runWriterLoop = async (): Promise<void> => {
      while (!sweepDone) {
        await sweepSleep(WRITER_INTERVAL_MS);
        if (sweepDone) break;
        try {
          const response = await writeCollateral();
          if (response.ok) collateralWrites += 1;
          else collateralFailures.push({ status: response.status, body: await response.text() });
        } catch (err) {
          collateralFailures.push({ status: null, error: err });
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

    const failureContext = JSON.stringify({
      firstConflict,
      evictions: server.instance.sessionManager.evictionCount,
    });
    expect(collateralWrites, failureContext).toBeGreaterThan(0);
    expect(collateralFailures, failureContext).toEqual([]);
  }, 30_000);
});
