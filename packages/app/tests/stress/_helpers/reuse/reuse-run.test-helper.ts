import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { JSONReportSpec } from '@playwright/test/reporter';
import { createNestedPlaywrightEnv } from '../port-ownership/nested-playwright-env.test-helper.ts';
import {
  runNestedPlaywright,
  specsOf,
} from '../port-ownership/nested-playwright-run.test-helper.ts';
import { APP_PACKAGE_ROOT, killGracefully } from '../server-process.ts';
import { REUSE_SOCKET_ENV } from './lease-protocol.ts';

const SUPERVISOR_CLI = fileURLToPath(new URL('./reuse-supervisor.ts', import.meta.url));
const RUN_CONFIG = fileURLToPath(new URL('./reuse-run.config.ts', import.meta.url));
const CASE_FILE = fileURLToPath(new URL('./leased-server.reuse-case.ts', import.meta.url));
const SUPERVISOR_READY_MS = 30_000;

export const CASE_SERVER_ANNOTATION = 'ok:reuse-case-server';
const SUPERVISOR_EXIT_MS = 60_000;

type SupervisorExit = { code: number | null; signal: NodeJS.Signals | null };

export interface RunningSupervisor {
  readonly socketPath: string;
  readonly proc: ChildProcess;
  readonly transcript: () => string;
  exitWithin(ms: number): Promise<SupervisorExit | 'still running'>;
  stop(): Promise<void>;
}

export async function startSupervisor(scratch: string): Promise<RunningSupervisor> {
  const socketPath = join(scratch, 'supervisor.sock');
  let transcript = '';
  const proc = spawn(
    process.execPath,
    [SUPERVISOR_CLI, 'serve', '--socket', socketPath, '--until-stdin-closes'],
    { cwd: APP_PACKAGE_ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  proc.stderr?.on('data', (chunk: Buffer) => {
    transcript += chunk.toString('utf8');
  });
  const exited = new Promise<SupervisorExit>((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const exitWithin = async (ms: number): Promise<SupervisorExit | 'still running'> => {
    let bound: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      exited,
      new Promise<'still running'>((resolve) => {
        bound = setTimeout(() => resolve('still running'), ms);
      }),
    ]).finally(() => clearTimeout(bound));
  };
  const stop = async () => {
    proc.stdin?.end();
    if ((await exitWithin(SUPERVISOR_EXIT_MS)) === 'still running') await killGracefully(proc);
  };
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), SUPERVISOR_READY_MS);
    const lines = createInterface({ input: proc.stdout as NodeJS.ReadableStream });
    lines.on('line', (line) => {
      transcript += `${line}\n`;
      if (line === `${REUSE_SOCKET_ENV}=${socketPath}`) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    void exited.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!ready) {
    await stop();
    throw new Error(`the reuse supervisor did not start serving ${socketPath}:\n${transcript}`);
  }
  return { socketPath, proc, transcript: () => transcript, exitWithin, stop };
}

export interface ReuseCaseRun {
  readonly exitCode: number | null;
  readonly transcript: string;
  readonly specs: JSONReportSpec[];
}

function grepFor(titles: readonly string[]): string {
  return titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

export async function runReuseCase(socketPath: string, ...titles: string[]): Promise<ReuseCaseRun> {
  const { exitCode, transcript, report } = await runNestedPlaywright({
    args: ['--config', RUN_CONFIG, CASE_FILE, '--grep', grepFor(titles)],
    runDirPrefix: 'ok-reuse-case-',
    env: (runDir) =>
      createNestedPlaywrightEnv({
        [REUSE_SOCKET_ENV]: socketPath,
        OK_REUSE_CASE_RUN_DIR: runDir,
        PLAYWRIGHT_HTML_OPEN: 'never',
      }),
  });
  return {
    exitCode,
    transcript,
    specs: specsOf(report?.suites ?? []).filter((spec) => titles.includes(spec.title)),
  };
}

export function annotationsOf(run: ReuseCaseRun, type: string): Array<string | undefined> {
  return run.specs.flatMap((spec) =>
    spec.tests.flatMap((test) =>
      test.results.flatMap((result) =>
        result.annotations
          .filter((annotation) => annotation.type === type)
          .map((annotation) => annotation.description),
      ),
    ),
  );
}

export function statusesOf(run: ReuseCaseRun): Array<string | undefined> {
  return run.specs.flatMap((spec) =>
    spec.tests.flatMap((test) => test.results.map((result) => result.status)),
  );
}
