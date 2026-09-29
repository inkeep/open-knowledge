import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProblemType } from '@inkeep/open-knowledge-core';
import { test as base } from '@playwright/test';
import { resetContentToFixtureBaseline } from './content-reset.ts';
import { gotoWhileLoadProgresses, requireDeadlineAt } from './load-progress.ts';
import {
  APP_PACKAGE_ROOT,
  checkCollabSync,
  closeServerLog,
  getFreePort,
  killGracefully,
  openServerLog,
  prepareViteCacheDir,
  requireBoundMs,
  type ServerLog,
  tailServerLog,
  waitForHttpReady,
} from './server-process.ts';
import { declareSetupNonResult } from './setup-non-result.ts';
import { removeAllDuringTeardown, runTeardownPhases } from './teardown-fs.ts';

interface ProblemError extends Error {
  status?: number;
  type?: string;
}

const CONCURRENT_OVERWRITE_REFUSED_TYPE: ProblemType = 'urn:ok:error:concurrent-overwrite-refused';

export function isConcurrentOverwriteRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status, type } = error as ProblemError;
  return status === 409 && type === CONCURRENT_OVERWRITE_REFUSED_TYPE;
}

async function problemError(res: Response, message: string): Promise<ProblemError> {
  let body: { type?: unknown } | null = null;
  let parseFailure: unknown;
  try {
    body = (await res.json()) as { type?: unknown };
  } catch (error) {
    parseFailure = error;
  }
  const err: ProblemError =
    parseFailure === undefined ? new Error(message) : new Error(message, { cause: parseFailure });
  err.status = res.status;
  if (typeof body?.type === 'string') err.type = body.type;
  return err;
}

export interface WorkerServer {
  port: number;
  baseURL: string;
  contentDir: string;
}

export interface AgentIdentity {
  agentId: string;
  agentName: string;
  clientName?: string;
  colorSeed?: string;
}

export interface ApiHelpers {
  createPage(path: string): Promise<void>;
  replaceDoc(docName: string, markdown: string): Promise<void>;
  writeAsAgent(docName: string, markdown: string, identity: AgentIdentity): Promise<void>;
  testReset(docName?: string): Promise<void>;
  seedDocs(docs: Array<{ name: string; markdown: string }>): Promise<void>;
}

type WorkerFixtures = {
  workerServer: WorkerServer;
  workerServerEnv: Record<string, string>;
};

type TestFixtures = {
  api: ApiHelpers;
};

export const WORKER_SERVER_BUDGET_TOTAL_MS = 240_000;

export const WORKER_SERVER_BUDGET_RESERVES = {
  apiConfig: 2_000,
  collabSync: 10_000,
  warmupGoto: 60_000,
  warmupVisible: 60_000,
  devServerReap: 5_000,
  setupOverhead: 15_000,
  teardown: 15_000,
} as const;

export function isReserveTable(value: unknown): value is Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(([, ms]) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0)
  );
}

function describeRejectedReserves(reserves: unknown): string {
  if (Array.isArray(reserves)) return 'it is an array rather than a table of named shares';
  if (typeof reserves !== 'object' || reserves === null) {
    return `it is ${String(reserves)} rather than a table of named shares`;
  }
  const entries = Object.entries(reserves as Record<string, unknown>);
  if (entries.length === 0) return 'it names no share at all';
  const rejected = entries
    .filter(([, ms]) => !(typeof ms === 'number' && Number.isFinite(ms) && ms > 0))
    .map(([key, ms]) => `${key}=${String(ms)}`);
  return `these shares are not positive finite millisecond counts: ${rejected.join(', ')}`;
}

export function resolveReadinessBudgetMs(
  totalMs: number,
  reserves: Readonly<Record<string, number>>,
): number {
  if (!isReserveTable(reserves)) {
    throw new Error(
      `worker-server fixture budget cannot derive a readiness share from these reserves, because a share that is not a positive finite number grows the residual instead of shrinking it: ${describeRejectedReserves(reserves)}`,
    );
  }
  const reservedMs = Object.values(reserves).reduce((sum, ms) => sum + ms, 0);
  const readinessMs = totalMs - reservedMs;
  if (!(readinessMs > 0)) {
    throw new Error(
      `worker-server fixture budget of ${totalMs}ms leaves no readiness share: its named reserves already claim ${reservedMs}ms`,
    );
  }
  return readinessMs;
}

const FIRST_LOAD_STALL_SHARE_OF_NAVIGATION = 3 / 4;

export function resolveFirstLoadStallMs(navigationShareMs: number): number {
  return navigationShareMs * FIRST_LOAD_STALL_SHARE_OF_NAVIGATION;
}

export interface BudgetPhase {
  readonly name: string;
  readonly reserveMs: number;
  spentMs: number;
}

export function openBudgetPhase(name: string, reserveMs: number): BudgetPhase {
  return { name, reserveMs: requireBoundMs(reserveMs, `budget phase "${name}"`), spentMs: 0 };
}

export async function spendOnBudgetPhase<T>(
  phase: BudgetPhase,
  work: () => T | Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    phase.spentMs += Date.now() - startedAt;
  }
}

export function budgetPhaseOverrunMessage(phase: BudgetPhase, residue: string): string | undefined {
  if (phase.spentMs <= phase.reserveMs) return undefined;
  return `worker-server fixture phase "${phase.name}" spent ${phase.spentMs}ms against the ${phase.reserveMs}ms reserve it declares, borrowing ${phase.spentMs - phase.reserveMs}ms of the ${WORKER_SERVER_BUDGET_TOTAL_MS}ms slot every other phase shares: ${residue}`;
}

export type BudgetReserveKey = keyof typeof WORKER_SERVER_BUDGET_RESERVES;

export const PHASES_SPENT_BY_SETUP = [
  'apiConfig',
  'collabSync',
  'warmupGoto',
  'warmupVisible',
  'setupOverhead',
] as const satisfies readonly BudgetReserveKey[];

export const PHASES_LEFT_AFTER_SETUP: readonly BudgetReserveKey[] = (
  Object.keys(WORKER_SERVER_BUDGET_RESERVES) as BudgetReserveKey[]
).filter((key) => !(PHASES_SPENT_BY_SETUP as readonly string[]).includes(key));

const RESERVED_AFTER_SETUP_MS = PHASES_LEFT_AFTER_SETUP.reduce(
  (sum, key) => sum + WORKER_SERVER_BUDGET_RESERVES[key],
  0,
);

export const WORKER_SERVER_SETUP_STARVATION_LINE_MS =
  WORKER_SERVER_BUDGET_TOTAL_MS - RESERVED_AFTER_SETUP_MS;

const SETUP_STARVATION_LINE_NAME = `the worker-server fixture's ${WORKER_SERVER_SETUP_STARVATION_LINE_MS}ms setup starvation line, which keeps the last ${RESERVED_AFTER_SETUP_MS}ms of its ${WORKER_SERVER_BUDGET_TOTAL_MS}ms slot for the ${PHASES_LEFT_AFTER_SETUP.join(' and ')} phases`;

function budgetSlotStarvationMessage(elapsedMs: number, residue: string): string | undefined {
  if (elapsedMs <= WORKER_SERVER_SETUP_STARVATION_LINE_MS) return undefined;
  return `worker-server fixture setup reached ${elapsedMs}ms of the ${WORKER_SERVER_BUDGET_TOTAL_MS}ms slot, which leaves less than the ${RESERVED_AFTER_SETUP_MS}ms the ${PHASES_LEFT_AFTER_SETUP.join(' and ')} phases it has not run yet reserve between them: ${residue}`;
}

export function reportBudgetOverrun(
  phase: BudgetPhase,
  workerIndex: number,
  residue: string,
): string | undefined {
  const message = budgetPhaseOverrunMessage(phase, residue);
  if (message === undefined) return undefined;
  const tagged = `[fixture w${workerIndex}] ${message}`;
  console.warn(tagged);
  return tagged;
}

export function refuseStarvedBudgetSlot(
  phase: BudgetPhase,
  elapsedMs: number,
  residue: string,
): void {
  const starvation = budgetSlotStarvationMessage(elapsedMs, residue);
  if (starvation === undefined) return;
  const borrowed = budgetPhaseOverrunMessage(phase, residue);
  throw new Error(starvation + (borrowed === undefined ? '' : `\n${borrowed}`));
}

const SETUP_OVERHEAD_PHASE_NAME = 'setup overhead';
const TEARDOWN_PHASE_NAME = 'teardown';

const WORKER_SERVER_READINESS_BUDGET_MS = resolveReadinessBudgetMs(
  WORKER_SERVER_BUDGET_TOTAL_MS,
  WORKER_SERVER_BUDGET_RESERVES,
);

export async function checkApiConfig(baseURL: string, timeoutMs: number): Promise<void> {
  requireBoundMs(timeoutMs, 'checkApiConfig');
  let res: Response;
  try {
    res = await fetch(`${baseURL}/api/config`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`/api/config did not respond within ${timeoutMs}ms: ${String(err)}`);
  }
  if (res.status !== 200) {
    throw new Error(`/api/config returned status ${res.status}, expected 200`);
  }
  let body: {
    collabUrl?: unknown;
    previewUrl?: unknown;
    port?: unknown;
  } | null;
  try {
    body = (await res.json()) as typeof body;
  } catch (parseErr) {
    throw new Error(`/api/config returned 200 but body is not valid JSON: ${String(parseErr)}`);
  }
  if (
    !body ||
    typeof body.port !== 'number' ||
    (typeof body.collabUrl !== 'string' && body.collabUrl !== null)
  ) {
    throw new Error(`/api/config returned unexpected body shape: ${JSON.stringify(body)}`);
  }
}

async function waitForServerReady(
  baseURL: string,
  port: number,
  proc: ChildProcess,
): Promise<void> {
  await waitForHttpReady(baseURL, WORKER_SERVER_READINESS_BUDGET_MS, proc);
  await checkApiConfig(baseURL, WORKER_SERVER_BUDGET_RESERVES.apiConfig);
  await checkCollabSync(port, WORKER_SERVER_BUDGET_RESERVES.collabSync);
}

async function settleBeforeDeadline<T>(
  deadlineAt: number,
  leg: string,
  work: () => Promise<T>,
  releaseAbandoned?: (abandoned: T) => Promise<void>,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (!(remainingMs > 0)) {
    throw new Error(
      `${leg} was not started, because the warmup had already reached ${SETUP_STARVATION_LINE_NAME}`,
    );
  }
  const working = work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`${leg} had not settled when the warmup reached ${SETUP_STARVATION_LINE_NAME}`),
      );
      if (releaseAbandoned !== undefined) void working.then(releaseAbandoned, () => {});
    }, remainingMs);
  });
  try {
    return await Promise.race([working, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function closeReportingFailure(context: import('@playwright/test').BrowserContext): Promise<void> {
  return context.close().catch((err: unknown) => {
    console.warn(
      `[e2e warmup] closing the first-load browser context failed, so it may stay open until the worker's browser closes; the warmup's own result stands: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function closeBeforeDeadline(
  context: import('@playwright/test').BrowserContext,
  deadlineAt: number,
): Promise<void> {
  const closing = closeReportingFailure(context);
  const remainingMs = deadlineAt - Date.now();
  if (!(remainingMs > 0)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, remainingMs);
  });
  try {
    await Promise.race([closing, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function warmupAppFirstLoad(
  browser: import('@playwright/test').Browser,
  baseURL: string,
  overhead: BudgetPhase,
  deadlineAt: number,
): Promise<void> {
  requireDeadlineAt(deadlineAt, 'warmupAppFirstLoad');
  const context = await spendOnBudgetPhase(overhead, () =>
    settleBeforeDeadline(
      deadlineAt,
      'browser.newContext',
      () => browser.newContext(),
      closeReportingFailure,
    ),
  );
  try {
    const page = await spendOnBudgetPhase(overhead, () =>
      settleBeforeDeadline(deadlineAt, 'context.newPage', () => context.newPage()),
    );
    await gotoWhileLoadProgresses(
      page,
      `${baseURL}/`,
      resolveFirstLoadStallMs(WORKER_SERVER_BUDGET_RESERVES.warmupGoto),
      deadlineAt,
      SETUP_STARVATION_LINE_NAME,
    );
    await settleBeforeDeadline(deadlineAt, 'the tree wait', () =>
      page
        .getByRole('treeitem', { name: REQUIRED_FIXTURE_ENTRY_NAMES[0], exact: true })
        .waitFor({ state: 'visible', timeout: WORKER_SERVER_BUDGET_RESERVES.warmupVisible }),
    );
  } finally {
    await spendOnBudgetPhase(overhead, () => closeBeforeDeadline(context, deadlineAt));
  }
}

export const REQUIRED_FIXTURE_ENTRY_NAMES = ['test-doc.md', 'sidebar-folder'] as const;

const REQUIRED_FIXTURE_DOC_NAMES = ['test-doc', 'sidebar-folder/nested-doc'] as const;

async function waitForSeededPagesSettled(baseURL: string, seededNames: string[]): Promise<void> {
  const missingSet = new Set(seededNames);
  const allowedTopSegments = new Set<string>([
    ...REQUIRED_FIXTURE_DOC_NAMES.map((n) => n.split('/')[0] ?? n),
    ...seededNames.map((n) => n.split('/')[0] ?? n),
  ]);
  const SETTLE_TIMEOUT_MS = 30_000;
  const RESCUE_AFTER_MS = 8_000;
  const started = Date.now();
  let rescued = false;
  let lastState = '(no /api/pages response yet)';
  while (true) {
    const remaining = SETTLE_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) break;
    const res = await fetch(`${baseURL}/api/pages`, {
      signal: AbortSignal.timeout(remaining),
    }).catch((err: unknown) => {
      lastState = `fetch error: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    });
    if (res?.ok) {
      let body: { pages?: Array<{ docName: string }> } | null = null;
      try {
        body = (await res.json()) as { pages?: Array<{ docName: string }> };
      } catch {
        lastState = '/api/pages returned 200 with a non-JSON body';
      }
      if (body) {
        const docNames = (body.pages ?? []).map((p) => p.docName).filter((n) => !n.startsWith('.'));
        const missing = docNames.reduce((set, n) => {
          set.delete(n);
          return set;
        }, new Set(missingSet));
        const extras = docNames.filter((n) => !allowedTopSegments.has(n.split('/')[0] ?? n));
        if (missing.size === 0 && extras.length === 0) return;
        lastState = `missing=[${[...missing].join(', ')}] extras=[${extras.join(', ')}]`;
      }
    }
    if (!rescued && Date.now() - started > RESCUE_AFTER_MS) {
      rescued = true;
      const rescueRes = await fetch(`${baseURL}/api/test-rescan-files`, {
        method: 'POST',
        signal: AbortSignal.timeout(Math.max(1, SETTLE_TIMEOUT_MS - (Date.now() - started))),
      }).catch((err: unknown) => {
        lastState = `rescue-fetch error: ${err instanceof Error ? err.message : String(err)}`;
        return null;
      });
      if (rescueRes && !rescueRes.ok) {
        lastState = `rescue-fetch returned ${rescueRes.status}`;
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `seeded docs did not settle in /api/pages within ${SETTLE_TIMEOUT_MS}ms: ${lastState}`,
  );
}

function seedRequiredFixtureFiles(contentDir: string): void {
  writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');
  mkdirSync(join(contentDir, 'sidebar-folder'), { recursive: true });
  writeFileSync(join(contentDir, 'sidebar-folder', 'nested-doc.md'), '', 'utf-8');
  mkdirSync(join(contentDir, '.claude', 'skills'), { recursive: true });
}

interface StartedWorkerServer {
  port: number;
  baseURL: string;
  contentDir: string;
  viteCacheDir: string;
  serverLog: ServerLog;
  proc: ChildProcess;
}

function setupResidueOf(started: StartedWorkerServer): string {
  return `the detached dev server on port ${started.port}, the content dir ${started.contentDir} and the vite cache dir ${started.viteCacheDir} are reaped and removed by whichever of the failure path and the teardown path this worker reaches`;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  workerServerEnv: [{}, { scope: 'worker', option: true }],
  workerServer: [
    async ({ workerServerEnv, browser }, use, workerInfo) => {
      const fixtureStartedAt = Date.now();
      const setupOverhead = openBudgetPhase(
        SETUP_OVERHEAD_PHASE_NAME,
        WORKER_SERVER_BUDGET_RESERVES.setupOverhead,
      );
      const releaseSetupResources: Array<() => void | Promise<void>> = [];
      let openedServerLog: ServerLog | undefined;
      let started: StartedWorkerServer | undefined;

      try {
        started = await spendOnBudgetPhase(setupOverhead, async () => {
          const port = await getFreePort();

          const contentDir = mkdtempSync(join(tmpdir(), `ok-w${workerInfo.workerIndex}-`));
          releaseSetupResources.push(() => removeAllDuringTeardown(contentDir));

          const viteCacheDir = prepareViteCacheDir(`w${workerInfo.workerIndex}`);
          releaseSetupResources.push(() => removeAllDuringTeardown(viteCacheDir));

          seedRequiredFixtureFiles(contentDir);

          const serverLog = openServerLog(`w${workerInfo.workerIndex}`);
          openedServerLog = serverLog;
          releaseSetupResources.push(() => closeServerLog(serverLog));

          const proc = spawn('pnpm', ['run', 'dev', '--host', '127.0.0.1'], {
            cwd: APP_PACKAGE_ROOT,
            detached: true,
            env: {
              ...process.env,
              ...workerServerEnv,
              VITE_PORT: String(port),
              OK_TEST_CONTENT_DIR: contentDir,
              OK_TEST_VITE_CACHE_DIR: viteCacheDir,
              OK_TEST_SKIP_I18N_COMPILE: '1',
              OK_TEST_GIT_ENABLED: '1',
              NO_COLOR: process.env.NO_COLOR ?? '1',
            },
            stdio: ['ignore', serverLog.fd, 'inherit'],
          });
          releaseSetupResources.push(() =>
            killGracefully(proc, WORKER_SERVER_BUDGET_RESERVES.devServerReap),
          );

          proc.on('error', (err) => {
            console.error(`[fixture w${workerInfo.workerIndex}] spawn error:`, err);
          });

          return {
            port,
            baseURL: `http://127.0.0.1:${port}`,
            contentDir,
            viteCacheDir,
            serverLog,
            proc,
          };
        });

        const residue = setupResidueOf(started);
        reportBudgetOverrun(setupOverhead, workerInfo.workerIndex, residue);

        await waitForServerReady(started.baseURL, started.port, started.proc);
        await warmupAppFirstLoad(
          browser,
          started.baseURL,
          setupOverhead,
          fixtureStartedAt + WORKER_SERVER_SETUP_STARVATION_LINE_MS,
        );
        reportBudgetOverrun(setupOverhead, workerInfo.workerIndex, residue);
        refuseStarvedBudgetSlot(setupOverhead, Date.now() - fixtureStartedAt, residue);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const borrowed = budgetPhaseOverrunMessage(
          setupOverhead,
          'this failure reaps the dev server and removes the dirs the setup had created',
        );
        let drainFailure: string | undefined;
        try {
          await runTeardownPhases(...[...releaseSetupResources].reverse());
        } catch (cleanupErr) {
          drainFailure = `--- cleanup after this failure did not complete: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)} ---`;
        }
        const tail =
          openedServerLog === undefined
            ? '--- no dev server log was open when this failure ended the setup ---'
            : `--- dev server log tail (${openedServerLog.path}) ---\n${tailServerLog(openedServerLog)}`;
        declareSetupNonResult(base.info(), reason);
        throw new Error(
          `${reason}${borrowed === undefined ? '' : `\n${borrowed}`}${drainFailure === undefined ? '' : `\n${drainFailure}`}\n${tail}`,
        );
      }

      const { port, baseURL, contentDir, viteCacheDir, serverLog, proc } = started;

      await use({ port, baseURL, contentDir });

      const teardown = openBudgetPhase(TEARDOWN_PHASE_NAME, WORKER_SERVER_BUDGET_RESERVES.teardown);
      try {
        await killGracefully(proc, WORKER_SERVER_BUDGET_RESERVES.devServerReap);
      } finally {
        await spendOnBudgetPhase(teardown, () => {
          closeServerLog(serverLog);
          removeAllDuringTeardown(serverLog.path, contentDir, viteCacheDir);
        });
      }
      reportBudgetOverrun(
        teardown,
        workerInfo.workerIndex,
        `the dev server was reaped and ${serverLog.path}, ${contentDir} and ${viteCacheDir} were removed before this report`,
      );
    },
    { scope: 'worker', timeout: WORKER_SERVER_BUDGET_TOTAL_MS },
  ],

  baseURL: async ({ workerServer }, use) => {
    await use(workerServer.baseURL);
  },

  api: async ({ workerServer }, use) => {
    const { baseURL } = workerServer;
    const API_CALL_TIMEOUT_MS = 30_000;
    async function post(path: string, body?: unknown): Promise<Response> {
      try {
        return await fetch(`${baseURL}${path}`, {
          method: 'POST',
          ...(body !== undefined
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
          signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS),
        });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new Error(
            `POST ${path} timed out after ${API_CALL_TIMEOUT_MS}ms — server stalled mid-test (port ${workerServer.port})`,
          );
        }
        throw err;
      }
    }
    const helpers: ApiHelpers = {
      async createPage(path: string): Promise<void> {
        const res = await post('/api/create-page', { path });
        if (res.status === 409) return;
        if (!res.ok) {
          throw new Error(`create-page failed for ${path}: ${res.status}`);
        }
      },
      async replaceDoc(docName: string, markdown: string): Promise<void> {
        const res = await post('/api/agent-write-md', { docName, markdown, position: 'replace' });
        if (!res.ok) {
          throw await problemError(res, `agent-write-md failed for ${docName}: ${res.status}`);
        }
      },
      async writeAsAgent(docName: string, markdown: string, identity): Promise<void> {
        const res = await post('/api/agent-write-md', {
          docName,
          markdown,
          position: 'replace',
          agentId: identity.agentId,
          agentName: identity.agentName,
          clientName: identity.clientName,
          colorSeed: identity.colorSeed,
        });
        if (!res.ok) {
          throw await problemError(
            res,
            `writeAsAgent failed for ${docName} / ${identity.agentId}: ${res.status}`,
          );
        }
      },
      async testReset(docName?: string): Promise<void> {
        const res = await post(
          docName ? `/api/test-reset?docName=${encodeURIComponent(docName)}` : '/api/test-reset',
        );
        if (!res.ok) {
          throw new Error(`test-reset failed${docName ? ` for ${docName}` : ''}: ${res.status}`);
        }
      },
      async seedDocs(docs: Array<{ name: string; markdown: string }>): Promise<void> {
        await resetContentToFixtureBaseline(baseURL, workerServer.contentDir);
        await helpers.testReset();
        const docNameOf = (name: string) => name.replace(/\.(md|mdx)$/i, '');
        for (const d of docs) {
          await helpers.createPage(/\.(md|mdx)$/i.test(d.name) ? d.name : `${d.name}.md`);
        }
        for (const d of docs) await helpers.replaceDoc(docNameOf(d.name), d.markdown);
        await waitForSeededPagesSettled(
          baseURL,
          docs.map((d) => docNameOf(d.name)),
        );
      },
    };
    await use(helpers);
  },
});

export { expect } from '@playwright/test';
