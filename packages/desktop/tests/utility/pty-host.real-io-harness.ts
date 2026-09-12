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
  createPtyHostProbe,
  waitForCondition,
  waitForEvaluatedInput,
  waitForShellReady,
} from '../support/pty-readiness.test-helper.ts';

const require = createRequire(import.meta.url);

function ensureSpawnHelperExecutable(): void {
  const pkgDir = dirname(dirname(require.resolve('node-pty')));
  const helper = join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

const { spawn } = require('node-pty') as { spawn: SpawnPty };

const createHost = (
  env: Record<string, string | undefined>,
  shellExists?: (path: string) => boolean,
): ReturnType<typeof createPtyHostProbe> => createPtyHostProbe({ spawn, env, shellExists });

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
let inFlight: string | null = null;
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  inFlight = name;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message });
    console.log(`FAIL ${name} :: ${(err as Error).message}`);
  } finally {
    inFlight = null;
  }
}

const BASE_ENV = { ...process.env };
const shellCommands = terminalSmokeShellCommands();
const CWD_PROOF_FILE = '.ok-pty-cwd-proof';
const WINDOWS_LAUNCH_WAIT = { timeoutMs: 20_000 } as const;

async function waitForWindowsInputReady(
  host: ReturnType<typeof createHost>,
  ptyId: string,
  label: string,
): Promise<void> {
  const probe = buildInputReadyProbe();
  const readyMs = await waitForEvaluatedInput(
    host.streamOf(ptyId),
    (data) => host.send({ type: 'input', ptyId, data }),
    { input: `${probe.command}\r`, marker: probe.marker },
    label,
  );
  console.log(`INPUT_READY ${label} readyMs=${readyMs}`);
}

async function waitForInteractiveShellReady(
  host: ReturnType<typeof createHost>,
  ptyId: string,
  label: string,
): Promise<void> {
  if (process.platform === 'win32') {
    await waitForWindowsInputReady(host, ptyId, label);
    return;
  }
  await waitForShellReady(host.streamOf(ptyId), label);
}

async function main(): Promise<void> {
  ensureSpawnHelperExecutable();

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pty-harness-')));

  await scenario('real command round-trip at project root', async () => {
    const cwdToken = randomUUID();
    writeFileSync(join(tmp, CWD_PROOF_FILE), cwdToken, 'utf8');
    const host = createHost(BASE_ENV);
    const io = host.streamOf('io');
    try {
      host.send({ type: 'create', ptyId: 'io', cwd: tmp, cols: 80, rows: 24 });
      await waitForInteractiveShellReady(host, 'io', 'interactive shell ready at project root');
      host.send({
        type: 'input',
        ptyId: 'io',
        data: `${shellCommands.arithmetic('HARNESS', 6, 7, 'DONE')}\r`,
      });
      await waitForCondition(
        io,
        () => io.read().includes('HARNESS_42_DONE'),
        'evaluated command output',
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
      );
    } finally {
      host.killActive();
    }
  });

  await scenario('strips desktop env markers from the shell', async () => {
    const host = createHost({
      ...BASE_ENV,
      OK_ELECTRON_PROTOCOL_HOST: '1',
      OK_LOCK_KIND: 'interactive',
    });
    const env = host.streamOf('env');
    try {
      host.send({ type: 'create', ptyId: 'env', cwd: tmp, cols: 80, rows: 24 });
      await waitForInteractiveShellReady(
        host,
        'env',
        'interactive shell ready with desktop markers stripped',
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
      );
      if (env.read().includes('LOCK=[interactive]')) {
        throw new Error('OK_LOCK_KIND leaked into the shell');
      }
    } finally {
      host.killActive();
    }
  });

  if (process.platform === 'win32') {
    await scenario('PowerShell executes a structured launch command', async () => {
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
      try {
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
          WINDOWS_LAUNCH_WAIT,
        );
        await waitForWindowsInputReady(
          host,
          'launch',
          'PowerShell remains interactive after EncodedCommand',
        );
        if (host.errorOf('launch') !== null) {
          throw new Error(`PowerShell launch failed: ${host.errorOf('launch')}`);
        }
      } finally {
        host.killActive();
      }
    });
  }

  await scenario('host survives a PTY death and respawns', async () => {
    const host = createHost(BASE_ENV);
    const first = host.streamOf('c1');
    const second = host.streamOf('c2');
    host.send({ type: 'create', ptyId: 'c1', cwd: tmp, cols: 80, rows: 24 });
    await waitForCondition(first, () => first.read().length > 0, 'first shell prompt');
    host.send({ type: 'kill', ptyId: 'c1' });
    await waitForCondition(first, () => host.exitOf('c1') !== null, 'exit after kill', {
      timeoutMs: 12_000,
    });
    host.send({ type: 'create', ptyId: 'c2', cwd: tmp, cols: 80, rows: 24 });
    await waitForCondition(
      second,
      () => second.read().length > 0,
      'second shell prompt (host survived)',
    );
    host.killActive();
  });

  await scenario('bad shell surfaces as a spawn failure', async () => {
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
    );
    const exit = host.exitOf('bad');
    if (exit && exit.exitCode === 0 && exit.signal === null) {
      throw new Error('expected a non-zero/failed exit for a bad shell');
    }
    host.killActive();
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`HARNESS_RESULT ok=${results.length - failed} fail=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

const hardTimeout = setTimeout(
  () => {
    const passed = results.filter((result) => result.ok).length;
    const failed = results.length - passed + 1;
    console.log(
      `HARNESS_RESULT ok=${passed} fail=${failed} :: hard timeout during ${inFlight ?? 'startup'}`,
    );
    process.exit(1);
  },
  process.platform === 'win32' ? 85_000 : 30_000,
);
hardTimeout.unref();

void main().catch((err) => {
  console.log(`HARNESS_RESULT ok=0 fail=1 :: ${(err as Error).message}`);
  process.exit(1);
});
