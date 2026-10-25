import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const require_ = createRequire(import.meta.url);
const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = fileURLToPath(new URL('../stress/_helpers/global-warm-cache.ts', import.meta.url));
const HOLDER = fileURLToPath(
  new URL('../stress/_helpers/warm-cache-owner-loss-holder.mjs', import.meta.url),
);
const GUARD = fileURLToPath(
  new URL('../stress/_helpers/warm-cache-owner-loss-guard.cjs', import.meta.url),
);
const TSX = require_.resolve('tsx');
const TERMINAL_WINDOW_MS = 5_000;
const TEST_BUDGET_MS = 28_000;

type SpawnEvent = {
  kind: 'spawn';
  childPid: number | undefined;
  file: string;
  args: string[] | undefined;
  detached: boolean;
  chain: boolean;
};
type GuardEvent =
  | { kind: 'loaded'; chain: boolean; argv: string[] }
  | SpawnEvent
  | {
      kind: 'child-exit';
      childPid: number | undefined;
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | { kind: 'owner-lost'; ownerPid: number }
  | { kind: 'parent-changed'; expectedParent: number; currentParent: number; ownerLost: boolean }
  | { kind: 'exit' | 'guard-cleanup' | 'parent-lost' | 'signal:SIGINT' | 'signal:SIGTERM' };
type ProcessDetail = { pid: number; file?: string; args?: string[]; argv?: string[] };
type TestEvent =
  | {
      kind: 'cleanup-incomplete';
      remainingPids: number[];
      remainingProcesses: ProcessDetail[];
      holderPid: number | undefined;
      message: string;
    }
  | { kind: 'test-finished' };
type EventRecord = { event: GuardEvent | TestEvent; pid: number; ppid?: number; time: number };
type EventKind = EventRecord['event']['kind'];

const SELF_EXIT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'exit',
  'parent-lost',
  'signal:SIGINT',
  'signal:SIGTERM',
]);
const CLEANUP_EXIT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  ...SELF_EXIT_KINDS,
  'guard-cleanup',
]);

test('warm-cache chain terminates when its setup owner exits', async () => {
  const testStart = Date.now();
  const bodyDeadline = testStart + TEST_BUDGET_MS - TERMINAL_WINDOW_MS;
  const cleanupDeadline = testStart + TEST_BUDGET_MS;
  const runDir = mkdtempSync(join(tmpdir(), 'ok-warm-cache-owner-loss-'));
  const runtimeTmp = join(runDir, 'tmp');
  const eventsPath = join(runDir, 'events.jsonl');
  const cleanupPath = join(runDir, 'cleanup');
  mkdirSync(runtimeTmp);
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require=${GUARD}`,
    OK_TEST_WARM_CACHE_OWNER_LOSS_CLEANUP: cleanupPath,
    OK_TEST_WARM_CACHE_OWNER_LOSS_EVENTS: eventsPath,
    OK_TEST_WARM_CACHE_OWNER_LOSS_SOURCE: SOURCE,
    OK_TEST_VITE_SEED_DIR: join(runDir, 'seed'),
    TMPDIR: runtimeTmp,
    OTEL_SDK_DISABLED: 'true',
  };
  const holder = spawn(process.execPath, ['--conditions=@inkeep/source', '--import', TSX, HOLDER], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let transcript = '';
  holder.stdout?.on('data', (chunk: Buffer) => {
    transcript += chunk.toString('utf8');
  });
  holder.stderr?.on('data', (chunk: Buffer) => {
    transcript += chunk.toString('utf8');
  });
  const holderClosed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    holder.once('close', (...result) => resolve(result)),
  );
  const events = (): EventRecord[] =>
    existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as EventRecord)
      : [];
  const waitFor = async (
    predicate: (records: EventRecord[]) => boolean,
    deadline: number,
    phase: string,
  ): Promise<EventRecord[]> => {
    let watcher: ReturnType<typeof watch> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return new Promise<EventRecord[]>((resolve, reject) => {
      const finish = (error?: Error) => {
        watcher?.close();
        if (timeout !== undefined) clearTimeout(timeout);
        if (error === undefined) resolve(events());
        else reject(error);
      };
      const check = () => {
        const records = events();
        if (predicate(records)) {
          finish();
          return;
        }
        if (Date.now() >= deadline) {
          finish(
            new Error(
              `timed out waiting for warm-cache ${phase}: ${JSON.stringify({ records, transcript })}`,
            ),
          );
        }
      };
      watcher = watch(runDir, check);
      watcher.on('error', (error) => finish(error));
      timeout = setTimeout(check, Math.max(0, deadline - Date.now()));
      check();
    });
  };
  const recordedPids = (records: EventRecord[]): number[] => {
    const pids = new Set<number>();
    const add = (pid: number | undefined) => {
      if (pid !== undefined && Number.isInteger(pid) && pid > 1 && pid !== holder.pid) {
        pids.add(pid);
      }
    };
    for (const record of records) {
      if (record.event.kind === 'loaded' && record.event.chain) {
        add(record.pid);
        add(record.ppid);
      }
      if (record.event.kind === 'spawn') add(record.event.childPid);
    }
    return [...pids];
  };
  const isLive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
        return false;
      }
      throw error;
    }
  };
  const endedByOwnEvidence = (
    records: EventRecord[],
    pid: number,
    exitKinds: ReadonlySet<EventKind>,
  ): boolean =>
    records.some(
      ({ event, pid: recordPid }) =>
        (recordPid === pid && exitKinds.has(event.kind)) ||
        (event.kind === 'child-exit' && event.childPid === pid),
    );
  const chainEnded = (
    records: EventRecord[],
    pids: number[],
    exitKinds: ReadonlySet<EventKind>,
  ): boolean => pids.every((pid) => endedByOwnEvidence(records, pid, exitKinds) || !isLive(pid));
  const findPnpmSpawn = (records: EventRecord[]): SpawnEvent | undefined => {
    for (const { event } of records) {
      if (event.kind === 'spawn' && event.file === 'pnpm') return event;
    }
    return undefined;
  };
  const findViteLoad = (records: EventRecord[]): EventRecord | undefined =>
    records.find(
      ({ event }) =>
        event.kind === 'loaded' &&
        event.chain &&
        event.argv.some((argument) => /[/\\]vite[/\\]/.test(argument)),
    );
  const waitForHolderClosed = async (
    deadline: number,
  ): Promise<[number | null, NodeJS.Signals | null] | undefined> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), remaining);
    });
    try {
      return await Promise.race([holderClosed, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  const recordedProcessDetails = (records: EventRecord[], pids: number[]): ProcessDetail[] => {
    const wanted = new Set(pids);
    return records.flatMap(({ event, pid }): ProcessDetail[] => {
      if (event.kind === 'spawn' && event.childPid !== undefined && wanted.has(event.childPid)) {
        return [{ pid: event.childPid, file: event.file, args: event.args }];
      }
      if (event.kind === 'loaded' && wanted.has(pid)) return [{ pid, argv: event.argv }];
      return [];
    });
  };
  let holderResult: [number | null, NodeJS.Signals | null] | undefined;
  let holderCloseTimedOut = false;
  let cleanupError: Error | undefined;
  try {
    const startRecords = await waitFor(
      (records) => findPnpmSpawn(records) !== undefined && findViteLoad(records) !== undefined,
      bodyDeadline,
      'Vite load',
    );
    const spawned = findPnpmSpawn(startRecords);
    const viteLoad = findViteLoad(startRecords);
    if (
      spawned?.childPid === undefined ||
      !Number.isInteger(spawned.childPid) ||
      spawned.childPid <= 1 ||
      viteLoad === undefined
    ) {
      throw new Error(`warm-cache pnpm spawn was not witnessed: ${JSON.stringify(startRecords)}`);
    }
    expect(isLive(viteLoad.pid), JSON.stringify({ transcript, records: startRecords })).toBe(true);
    if (!holder.kill('SIGKILL')) throw new Error('warm-cache owner holder did not accept SIGKILL');
    holderResult = await waitForHolderClosed(bodyDeadline);
    if (holderResult === undefined)
      throw new Error('warm-cache owner holder did not close in time');
    const ownerLossRecords = await waitFor(
      (records) => records.some(({ event }) => event.kind === 'owner-lost'),
      bodyDeadline,
      'owner loss',
    );
    let pids = recordedPids(ownerLossRecords);
    const deadline = Math.min(bodyDeadline, Date.now() + TERMINAL_WINDOW_MS);
    let terminalRecords = ownerLossRecords;
    while (!chainEnded(terminalRecords, pids, SELF_EXIT_KINDS) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      terminalRecords = events();
      pids = recordedPids(terminalRecords);
    }
    const diagnostics = JSON.stringify({ transcript, spawned, pids, records: terminalRecords });
    expect(holderResult, diagnostics).toEqual([null, 'SIGKILL']);
    expect(spawned.detached, diagnostics).toBe(true);
    expect(pids, diagnostics).toContain(viteLoad.pid);
    expect(chainEnded(terminalRecords, pids, SELF_EXIT_KINDS), diagnostics).toBe(true);
  } finally {
    writeFileSync(cleanupPath, 'cleanup\n', 'utf8');
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    if (holderResult === undefined) {
      holderResult = await waitForHolderClosed(cleanupDeadline);
      holderCloseTimedOut = holderResult === undefined;
    }
    try {
      await waitFor(
        (records) => chainEnded(records, recordedPids(records), CLEANUP_EXIT_KINDS),
        cleanupDeadline,
        'cleanup',
      );
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
    if (holderCloseTimedOut && cleanupError === undefined) {
      cleanupError = new Error('warm-cache owner holder did not close during cleanup');
    }
    if (cleanupError !== undefined) {
      const records = events();
      const remainingPids = recordedPids(records).filter((pid) => isLive(pid));
      const remainingProcesses = recordedProcessDetails(records, remainingPids);
      const incomplete: EventRecord = {
        event: {
          kind: 'cleanup-incomplete',
          remainingPids,
          remainingProcesses,
          holderPid: holder.pid,
          message: cleanupError.message,
        },
        pid: process.pid,
        time: Date.now(),
      };
      appendFileSync(eventsPath, `${JSON.stringify(incomplete)}\n`);
      console.error(
        `[warm-cache owner-loss] cleanup incomplete: ${JSON.stringify({
          runDir,
          remainingPids,
          remainingProcesses,
          holderPid: holder.pid,
          message: cleanupError.message,
        })}`,
      );
    }
    const finished: EventRecord = {
      event: { kind: 'test-finished' },
      pid: process.pid,
      time: Date.now(),
    };
    appendFileSync(eventsPath, `${JSON.stringify(finished)}\n`);
    if (cleanupError === undefined) rmSync(runDir, { recursive: true, force: true });
  }
  if (cleanupError !== undefined) throw cleanupError;
});
