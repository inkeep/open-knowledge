import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpawnPty } from '../../src/utility/pty-host.ts';
import {
  buildInputReadyProbe,
  terminalSmokeShellCommands,
} from '../smoke/_helpers/terminal-smoke-shell.ts';
import {
  buildCwdFileProofCommand,
  createHarnessBudget,
  createPtyHostProbe,
  HARNESS_REPORT_RESERVE_MS,
  HarnessBudgetRefusal,
  harnessExitAfterKillWait,
  harnessTimeouts,
  harnessWindowsLaunchWait,
  remainingGrantMs,
  resolveHarnessBudgetMs,
  waitForCondition,
  waitForEvaluatedInput,
  waitForShellReady,
} from '../support/pty-readiness.test-helper.ts';
import { createHarnessScenarioRunner } from '../support/pty-startup-trace.test-helper.ts';
import { harnessScenarioTitles } from '../support/real-io-harness-roster.test-helper.ts';

const require = createRequire(import.meta.url);

function ensureSpawnHelperExecutable(): void {
  const pkgDir = dirname(dirname(require.resolve('node-pty')));
  const helper = join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

const { spawn } = require('node-pty') as { spawn: SpawnPty };

const hostLogger = {
  warn: (entry: Record<string, unknown>) => console.log(`PTY_HOST warn ${JSON.stringify(entry)}`),
  info: (entry: Record<string, unknown>) => console.log(`PTY_HOST info ${JSON.stringify(entry)}`),
};

const runner = createHarnessScenarioRunner({
  titles: harnessScenarioTitles(process.platform),
  grantMs: (before) => harnessBudget.grantMs(before),
  isRefusal: (error) => error instanceof HarnessBudgetRefusal,
  print: (line) => console.log(line),
});
const createHost = (
  env: Record<string, string | undefined>,
  shellExists?: (path: string) => boolean,
): ReturnType<typeof createPtyHostProbe> => {
  const host = createPtyHostProbe({
    spawn,
    env,
    shellExists,
    logger: hostLogger,
    startupTrace: { native: process.platform === 'win32' },
  });
  runner.own({ snapshot: () => host.snapshotStartup(), release: () => host.killActive() });
  return host;
};

const BASE_ENV = { ...process.env };
const shellCommands = terminalSmokeShellCommands();
const CWD_PROOF_FILE = '.ok-pty-cwd-proof';
const HARNESS_BUDGET_MS = resolveHarnessBudgetMs(
  process.env.OK_PTY_HARNESS_BUDGET_MS,
  harnessTimeouts(process.platform).budgetMs,
);
const harnessBudget = createHarnessBudget(HARNESS_BUDGET_MS, HARNESS_REPORT_RESERVE_MS);

async function waitForWindowsInputReady(
  host: ReturnType<typeof createHost>,
  ptyId: string,
  label: string,
  deadlineAt: number,
): Promise<void> {
  const probe = buildInputReadyProbe();
  const timing = await waitForEvaluatedInput(
    host.streamOf(ptyId),
    (data) => host.send({ type: 'input', ptyId, data }),
    { input: `${probe.command}\r`, marker: probe.marker },
    label,
    { budgetMs: remainingGrantMs(deadlineAt, label) },
  );
  console.log(
    `INPUT_READY ${label} firstOutputMs=${timing.firstOutputMs} firstOutput=${timing.firstOutput} readyMs=${timing.roundTripMs}`,
  );
}

async function waitForInteractiveShellReady(
  host: ReturnType<typeof createHost>,
  ptyId: string,
  label: string,
  deadlineAt: number,
): Promise<void> {
  if (process.platform === 'win32') {
    await waitForWindowsInputReady(host, ptyId, label, deadlineAt);
    return;
  }
  await waitForShellReady(host.streamOf(ptyId), label, { backstopAt: deadlineAt });
}

async function main(): Promise<void> {
  ensureSpawnHelperExecutable();

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pty-harness-')));

  await runner.run('real command round-trip at project root', async (deadlineAt) => {
    const cwdToken = randomUUID();
    writeFileSync(join(tmp, CWD_PROOF_FILE), cwdToken, 'utf8');
    const host = createHost(BASE_ENV);
    const io = host.streamOf('io');
    host.send({ type: 'create', ptyId: 'io', cwd: tmp, cols: 80, rows: 24 });
    await waitForInteractiveShellReady(
      host,
      'io',
      'interactive shell ready at project root',
      deadlineAt,
    );
    host.send({
      type: 'input',
      ptyId: 'io',
      data: `${shellCommands.arithmetic('HARNESS', 6, 7, 'DONE')}\r`,
    });
    await waitForCondition(
      io,
      () => io.read().includes('HARNESS_42_DONE'),
      'evaluated command output',
      { backstopAt: deadlineAt },
    );
    host.send({
      type: 'input',
      ptyId: 'io',
      data: `${buildCwdFileProofCommand(process.platform, CWD_PROOF_FILE)}\r`,
    });
    await waitForCondition(
      io,
      () => io.read().includes(`CWD_PROOF=${cwdToken}`),
      'relative sentinel read at project root',
      { backstopAt: deadlineAt },
    );
  });

  await runner.run('strips desktop env markers from the shell', async (deadlineAt) => {
    const host = createHost({
      ...BASE_ENV,
      OK_ELECTRON_PROTOCOL_HOST: '1',
      OK_LOCK_KIND: 'interactive',
    });
    const env = host.streamOf('env');
    host.send({ type: 'create', ptyId: 'env', cwd: tmp, cols: 80, rows: 24 });
    await waitForInteractiveShellReady(
      host,
      'env',
      'interactive shell ready with desktop markers stripped',
      deadlineAt,
    );
    host.send({
      type: 'input',
      ptyId: 'env',
      data: `${shellCommands.readEnvironment('OK_LOCK_KIND', 'LOCK')}\r`,
    });
    host.send({
      type: 'input',
      ptyId: 'env',
      data: `${shellCommands.readEnvironment('OK_ELECTRON_PROTOCOL_HOST', 'HOST')}\r`,
    });
    await waitForCondition(
      env,
      () => env.read().includes('LOCK=[]') && env.read().includes('HOST=[]'),
      'empty markers in shell',
      { backstopAt: deadlineAt },
    );
    if (env.read().includes('LOCK=[interactive]')) {
      throw new Error('OK_LOCK_KIND leaked into the shell');
    }
  });

  if (process.platform === 'win32') {
    await runner.run('PowerShell executes a structured launch command', async (deadlineAt) => {
      const powershell = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      if (!existsSync(powershell)) throw new Error(`Windows PowerShell is missing: ${powershell}`);

      const launchToken = randomUUID();
      const host = createHost({
        ...BASE_ENV,
        OK_HARNESS_LAUNCH_TOKEN: launchToken,
      });
      const launch = host.streamOf('launch');
      host.send({
        type: 'create',
        ptyId: 'launch',
        cwd: tmp,
        cols: 80,
        rows: 24,
        shell: powershell,
        launchCommand: {
          executable: 'cmd.exe',
          args: ['/d', '/c', 'echo', '%OK_HARNESS_LAUNCH_TOKEN%'],
        },
      });
      await waitForCondition(
        launch,
        () => launch.read().includes(launchToken),
        'PowerShell EncodedCommand output',
        harnessWindowsLaunchWait(deadlineAt),
      );
      await waitForWindowsInputReady(
        host,
        'launch',
        'PowerShell remains interactive after EncodedCommand',
        deadlineAt,
      );
      if (host.errorOf('launch') !== null) {
        throw new Error(`PowerShell launch failed: ${host.errorOf('launch')}`);
      }
    });
  }

  await runner.run('host survives a PTY death and respawns', async (deadlineAt) => {
    const host = createHost(BASE_ENV);
    const first = host.streamOf('c1');
    const second = host.streamOf('c2');
    host.send({ type: 'create', ptyId: 'c1', cwd: tmp, cols: 80, rows: 24 });
    await waitForCondition(first, () => first.read().length > 0, 'first shell prompt', {
      backstopAt: deadlineAt,
    });
    host.send({ type: 'kill', ptyId: 'c1' });
    await waitForCondition(
      first,
      () => host.exitOf('c1') !== null,
      'exit after kill',
      harnessExitAfterKillWait(deadlineAt),
    );
    host.send({ type: 'create', ptyId: 'c2', cwd: tmp, cols: 80, rows: 24 });
    await waitForCondition(
      second,
      () => second.read().length > 0,
      'second shell prompt (host survived)',
      { backstopAt: deadlineAt },
    );
  });

  await runner.run('bad shell surfaces as a spawn failure', async (deadlineAt) => {
    const badShell = join(
      tmp,
      process.platform === 'win32' ? 'no-such-shell-xyz.exe' : 'no-such-shell-xyz',
    );
    const host = createHost(BASE_ENV, (path) => path === badShell || existsSync(path));
    const bad = host.streamOf('bad');
    host.send({
      type: 'create',
      ptyId: 'bad',
      cwd: tmp,
      cols: 80,
      rows: 24,
      shell: badShell,
    });
    await waitForCondition(
      bad,
      () => host.exitOf('bad') !== null || host.errorOf('bad') !== null,
      'failure for unspawnable shell',
      { backstopAt: deadlineAt },
    );
    const exit = host.exitOf('bad');
    if (exit && exit.exitCode === 0 && exit.signal === null) {
      throw new Error('expected a non-zero/failed exit for a bad shell');
    }
  });

  const unrun = runner.unrunTitles();
  if (unrun.length > 0) {
    console.log(runner.verdictLine(` :: never ran ${unrun.join(', ')}`));
    process.exit(1);
  }
  console.log(runner.verdictLine(''));
  process.exit(runner.passed() ? 0 : 1);
}

const hardTimeout = setTimeout(() => {
  console.log(runner.hardTimeoutVerdict());
  process.exit(1);
}, HARNESS_BUDGET_MS);
hardTimeout.unref();

void main().catch((err) => {
  console.log(runner.verdictLine(` :: ${(err as Error).message}`));
  process.exit(1);
});
