import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper.ts';
import {
  QUIT_DRAIN_RESULT_PREFIX,
  type QuitDrainHarnessResult,
  type QuitDrainMode,
} from './project-server-quit-drain.test-helper.ts';

const HARNESS = fileURLToPath(new URL('./project-server-quit-drain.harness.ts', import.meta.url));
const DESKTOP_DIR = fileURLToPath(new URL('../..', import.meta.url));
const HARNESS_TEST_TIMEOUT_MS = 120_000;
const OK_DEBUG_ENV_PREFIX = 'OK_DEBUG_';
const GIT_ENV_PREFIX = 'GIT_';

const scratchDirs: string[] = [];
const harnesses: Array<{ child: ChildProcess; closed: Promise<void> }> = [];

afterEach(async () => {
  for (const { child, closed } of harnesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
  for (const dir of scratchDirs.splice(0)) removeTempDirBestEffort(dir);
});

function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

function fixtureProject(): string {
  const projectDir = scratchDir('ok-quit-drain-project-');
  writeFileSync(join(projectDir, 'start.md'), '# Start\n\nquit drain fixture\n');
  mkdirSync(join(projectDir, 'docs'));
  writeFileSync(join(projectDir, 'docs', 'second.md'), '# Second\n');
  return projectDir;
}

function harnessEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(OK_DEBUG_ENV_PREFIX) && !name.startsWith(GIT_ENV_PREFIX))
      env[name] = value;
  }
  const gitConfig = join(home, '.gitconfig');
  writeFileSync(gitConfig, '[user]\n\tname = Quit Drain\n\temail = quit-drain@example.com\n');
  return { ...env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitConfig };
}

interface HarnessRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  result: QuitDrainHarnessResult | null;
}

function runHarness(mode: QuitDrainMode): Promise<HarnessRun> {
  const projectDir = fixtureProject();
  const home = scratchDir('ok-quit-drain-home-');
  const child = spawn(process.execPath, ['--conditions=development', HARNESS, projectDir, mode], {
    cwd: DESKTOP_DIR,
    env: harnessEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolveClosed) => {
    child.once('close', () => resolveClosed());
  });
  harnesses.push({ child, closed });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  return new Promise<HarnessRun>((resolveRun, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const line = output
        .split('\n')
        .find((candidate) => candidate.startsWith(QUIT_DRAIN_RESULT_PREFIX));
      resolveRun({
        code,
        signal,
        output,
        result:
          line === undefined
            ? null
            : (JSON.parse(line.slice(QUIT_DRAIN_RESULT_PREFIX.length)) as QuitDrainHarnessResult),
      });
    });
  });
}

function diagnosticsOf(run: HarnessRun): string {
  return `harness exit code=${run.code} signal=${run.signal}\n${run.output}`;
}

describe.skipIf(process.platform === 'win32')(
  'app quit while the project server releases its file watchers',
  () => {
    test(
      'the quit waits for the server utility to exit, so no watcher work is pending when its environment is freed',
      async () => {
        const run = await runHarness('quit-after-start');

        const diagnostics = diagnosticsOf(run);
        expect(run.result?.nativeSubscribes, diagnostics).toBeGreaterThan(0);
        expect(run.result?.nativeOpsStartedDuringShutdown, diagnostics).toBeGreaterThan(0);
        expect(run.result?.nativeWorkReleasedWhileQuitHeld, diagnostics).toBeGreaterThan(0);
        expect(run.result, diagnostics).toMatchObject({
          shutdownPostedToUtility: true,
          teardown: 'utility-exited',
          utilityExitCode: 0,
          nativeOpsPendingAtExit: 0,
          subscriptionsUnreleasedAtExit: 0,
          nativeOpsPendingAtTeardown: 0,
        });
        expect(run.signal, diagnostics).toBeNull();
        expect(run.code, diagnostics).toBe(0);
      },
      HARNESS_TEST_TIMEOUT_MS,
    );

    test(
      'a quit while the server is still starting waits for that start and releases every watcher before the utility exits',
      async () => {
        const run = await runHarness('quit-during-start');

        const diagnostics = diagnosticsOf(run);
        expect(run.result?.nativeSubscribes, diagnostics).toBeGreaterThan(0);
        expect(run.result, diagnostics).toMatchObject({
          quitBeganWithNativeWorkHeld: true,
          shutdownPostedToUtility: true,
          teardown: 'utility-exited',
          utilityExitCode: 0,
          serverStartSettledBeforeExit: true,
          nativeOpsPendingAtExit: 0,
          subscriptionsUnreleasedAtExit: 0,
          nativeOpsPendingAtTeardown: 0,
          projectOpenOutcome: 'app-quitting',
        });
        expect(run.signal, diagnostics).toBeNull();
        expect(run.code, diagnostics).toBe(0);
      },
      HARNESS_TEST_TIMEOUT_MS,
    );
  },
);
