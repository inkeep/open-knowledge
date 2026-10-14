import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type TestInfo, test, type WorkerInfo } from '@playwright/test';
import { resetContentToFixtureBaseline, resetFixtureFolders } from '../content-reset.ts';
import {
  checkApiConfig,
  openBudgetPhase,
  REQUIRED_FIXTURE_DOC_NAMES,
  WORKER_SERVER_BUDGET_RESERVES,
  WORKER_SERVER_SETUP_STARVATION_LINE_MS,
  type WorkerServer,
  warmupAppFirstLoad,
} from '../fixtures.ts';
import { workerServingKind } from '../prebuilt/prebuilt-serving.ts';
import { APP_PACKAGE_ROOT } from '../seed-key.ts';
import { checkCollabSync } from '../server-process.ts';
import { declareSetupNonResult } from '../setup-non-result.ts';
import {
  freshSlotResidue,
  parseServerResetResidue,
  serverResetResidueProblems,
} from './fresh-slot.ts';
import {
  type LeaseOutcome,
  type LeaseRequest,
  type LeaseVerdict,
  REUSE_RUN_ENV,
  REUSE_SOCKET_ENV,
} from './lease-protocol.ts';
import { recordRunAbort, runAbortReason } from './reuse-run.ts';
import { connectLeaseClient, type LeaseClient } from './supervisor-socket.ts';

export const SERVER_LEASE_ANNOTATION = 'ok:server-lease';

const SUPERVISOR_CONNECT_MS = 5_000;
const SUPERVISOR_CALL_MS = 10_000;
const LEASE_RESET_MS = 30_000;

export type ServerLease =
  | {
      readonly kind: 'leased';
      readonly run: string;
      readonly server: WorkerServer;
      readonly note: string;
      verify(): Promise<LeaseVerdict>;
    }
  | { readonly kind: 'fresh'; readonly note: string };

let currentLease: ServerLease | undefined;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remainingMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

async function requestTestReset(server: WorkerServer, query: string): Promise<unknown> {
  const response = await fetch(`${server.baseURL}/api/test-reset?${query}`, {
    method: 'POST',
    signal: AbortSignal.timeout(LEASE_RESET_MS),
  });
  if (!response.ok) {
    throw new Error(
      `test-reset?${query} returned status ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function resetLeasedSlot(server: WorkerServer): Promise<void> {
  await resetContentToFixtureBaseline(server.baseURL, server.contentDir);
  await resetFixtureFolders(server.baseURL, server.contentDir);
  for (const docName of REQUIRED_FIXTURE_DOC_NAMES) {
    await requestTestReset(server, `docName=${encodeURIComponent(docName)}`);
  }
  const kept = serverResetResidueProblems(
    parseServerResetResidue(await requestTestReset(server, 'scope=server')),
  );
  if (kept.length > 0) throw new Error(`the server kept ${kept.join('; ')} after its reset`);
  const left = freshSlotResidue(server.contentDir, REQUIRED_FIXTURE_DOC_NAMES);
  if (left.length > 0) throw new Error(`the reset left ${left.join('; ')}`);
  await checkApiConfig(server.baseURL, WORKER_SERVER_BUDGET_RESERVES.apiConfig);
  await checkCollabSync(server.port, WORKER_SERVER_BUDGET_RESERVES.collabSync);
}

function abortedRunRefusal(slot: number, detail: string): Error {
  const reason = `server reuse refused slot ${slot}: ${detail}, so this invocation gives no further verdicts`;
  declareSetupNonResult(test.info(), reason);
  return new Error(reason);
}

function invocationConfig(workerInfo: WorkerInfo): string {
  return `${workerInfo.config.configFile ?? '(inline config)'}#${workerInfo.project.name}`;
}

export async function leaseWorkerServer(
  { workerServerEnv, browser }: { workerServerEnv: Record<string, string>; browser: Browser },
  use: (lease: ServerLease | undefined) => Promise<void>,
  workerInfo: WorkerInfo,
): Promise<void> {
  const socketPath = process.env[REUSE_SOCKET_ENV];
  if (socketPath === undefined || socketPath === '') {
    await use(undefined);
    return;
  }
  const slot = workerInfo.parallelIndex;
  const startFresh = async (note: string) => {
    console.warn(`[server reuse w${workerInfo.workerIndex}] ${note}`);
    currentLease = { kind: 'fresh', note };
    try {
      await use(currentLease);
    } finally {
      currentLease = undefined;
    }
  };
  const servingKind = workerServingKind(workerServerEnv, process.env);
  switch (servingKind) {
    case 'production-shell':
      await startFresh(
        `slot ${slot}: server reuse leases dev servers, and this worker serves the production shell, so this worker starts its own server`,
      );
      return;
    case 'prebuilt':
      await startFresh(
        `slot ${slot}: server reuse leases dev servers, and this invocation serves the prebuilt DEV app, so this worker starts its own server`,
      );
      return;
    case 'dev-server':
      break;
    default:
      servingKind satisfies never;
  }
  const run = process.env[REUSE_RUN_ENV];
  if (run === undefined || run === '') {
    await startFresh(
      `slot ${slot}: ${REUSE_SOCKET_ENV} asks for server reuse, but this invocation has no ${REUSE_RUN_ENV} because its config does not run the reuse globalSetup, so this worker starts its own server`,
    );
    return;
  }
  const abortedBecause = runAbortReason(run);
  if (abortedBecause !== undefined) {
    throw abortedRunRefusal(slot, `run ${run} lost an earlier lease: ${abortedBecause}`);
  }
  const deadlineAt = Date.now() + WORKER_SERVER_SETUP_STARVATION_LINE_MS;
  let client: LeaseClient;
  try {
    client = await connectLeaseClient(socketPath, SUPERVISOR_CONNECT_MS);
  } catch (error) {
    await startFresh(`slot ${slot}: ${describe(error)}, so this worker starts its own server`);
    return;
  }
  try {
    const request: LeaseRequest = {
      worktree: realpathSync(join(APP_PACKAGE_ROOT, '..', '..')),
      config: invocationConfig(workerInfo),
      run,
      slot,
      workerServerEnv,
      serverMode: 'dev',
    };
    let outcome: LeaseOutcome;
    try {
      outcome = await client.acquire(request, remainingMs(deadlineAt));
    } catch (error) {
      client.close();
      await startFresh(
        `slot ${slot}: the lease request failed (${describe(error)}), so this worker starts its own server`,
      );
      return;
    }
    if (outcome.kind === 'refused') {
      if (outcome.reason === 'run-aborted') throw abortedRunRefusal(slot, outcome.detail);
      client.close();
      await startFresh(
        `slot ${slot} was refused (${outcome.reason}: ${outcome.detail}), so this worker starts its own server`,
      );
      return;
    }
    const server: WorkerServer = {
      port: outcome.port,
      baseURL: outcome.baseURL,
      contentDir: outcome.contentDir,
    };
    try {
      if (outcome.launched) {
        const overhead = openBudgetPhase(
          'leased server warmup',
          WORKER_SERVER_BUDGET_RESERVES.setupOverhead,
        );
        await warmupAppFirstLoad(browser, server.baseURL, overhead, deadlineAt);
      } else {
        await resetLeasedSlot(server);
      }
    } catch (error) {
      const discarded = await client.release(outcome.token, true, SUPERVISOR_CALL_MS).then(
        () => 'so it was discarded and this worker starts its own server',
        (releaseError: unknown) =>
          `so this worker starts its own server; the supervisor did not confirm discarding the leased server (${describe(releaseError)})`,
      );
      client.close();
      await startFresh(
        `slot ${slot}: the leased server could not be ${outcome.launched ? 'warmed up' : 'reset'} (${describe(error)}), ${discarded}`,
      );
      return;
    }
    const note = outcome.launched
      ? `slot ${slot}: started an owned server at ${server.baseURL}${outcome.relaunchedBecause === null ? '' : ` because ${outcome.relaunchedBecause}`}`
      : `slot ${slot}: reused the owned server at ${server.baseURL}`;
    currentLease = {
      kind: 'leased',
      run,
      server,
      note,
      verify: () =>
        client.verify(outcome.token, SUPERVISOR_CALL_MS).catch(
          (error: unknown): LeaseVerdict => ({
            held: false,
            reason: `the supervisor could not confirm it: ${describe(error)}`,
          }),
        ),
    };
    try {
      await use(currentLease);
    } finally {
      currentLease = undefined;
    }
    await client.release(outcome.token, false, SUPERVISOR_CALL_MS).catch((error: unknown) => {
      console.warn(
        `[server reuse w${workerInfo.workerIndex}] slot ${slot}: releasing the lease failed (${describe(error)}); if the supervisor never received the release, closing its connection makes it discard the server`,
      );
    });
  } finally {
    client.close();
  }
}

async function requireHeldLease(
  lease: Extract<ServerLease, { kind: 'leased' }>,
  testInfo: TestInfo,
  when: string,
): Promise<void> {
  const verdict = await lease.verify();
  if (verdict.held) return;
  const reason = `the reused server's lease was lost ${when}: ${verdict.reason}`;
  declareSetupNonResult(testInfo, reason);
  recordRunAbort(lease.run, verdict.reason);
  throw new Error(reason);
}

export async function checkServerLease(
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
  {}: object,
  use: (value: undefined) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const before = currentLease;
  if (before?.kind === 'leased') await requireHeldLease(before, testInfo, 'before the test');
  await use(undefined);
  const after = currentLease;
  if (after === undefined) return;
  testInfo.annotations.push({ type: SERVER_LEASE_ANNOTATION, description: after.note });
  if (after.kind === 'leased') await requireHeldLease(after, testInfo, 'during the test');
}
