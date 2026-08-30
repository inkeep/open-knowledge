/**
 * Real-shell-I/O harness for the PTY host.
 *
 * This harness drives the actual `setupPtyHost` factory with a real `node-pty`
 * spawn under Node and asserts the real-I/O contract end to end.
 * `pty-host-real-io.test.ts` invokes it as an isolated subprocess and asserts
 * on its exit code + result line.
 *
 * Scenarios: real command round-trip, cwd binding + env-marker stripping,
 * Windows PowerShell launch composition, host-survives-PTY-death containment,
 * bad-shell async exit.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpawnPty } from '../../src/utility/pty-host.ts';
import { terminalSmokeShellCommands } from '../smoke/_helpers/terminal-smoke-shell.ts';
import {
  buildCwdFileProofCommand,
  createPtyHostProbe,
  waitForCondition,
  waitForShellReady,
} from '../support/pty-readiness.test-helper.ts';

const require = createRequire(import.meta.url);

// node-pty's prebuilt `spawn-helper` ships mode 0644 (node-pty#850); a real
// PTY spawn fails with "posix_spawnp failed" until it is executable. The
// packaged app fixes this in afterPack; for the dev node_modules we chmod the
// current-arch helper here.
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

function createWindowsReadinessLaunch(): {
  marker: string;
  launchCommand: { executable: string; args: string[] };
} | null {
  if (process.platform !== 'win32') return null;
  // Never probe or retry with control characters before this marker: an early
  // Ctrl+C can be taken as process termination (NTSTATUS 0xC000013A) before the
  // shell's line editor owns the console. These scenarios pass no `shell:`, so
  // the ladder picks whatever the host resolves (pwsh 7 on `windows-latest`).
  // The structured command is the non-mutating startup gate; the real command
  // immediately after it proves interactive input.
  const marker = `OK_SHELL_READY_${randomUUID().replaceAll('-', '')}`;
  return {
    marker,
    launchCommand: { executable: 'cmd.exe', args: ['/d', '/c', 'echo', marker] },
  };
}

async function waitForInteractiveShellReady(
  host: ReturnType<typeof createHost>,
  ptyId: string,
  label: string,
  windowsLaunchMarker: string | null,
): Promise<void> {
  const stream = host.streamOf(ptyId);
  if (process.platform === 'win32') {
    if (windowsLaunchMarker === null) {
      throw new Error('Windows input-driven scenarios require a startup launch marker');
    }
    await waitForCondition(
      stream,
      () => stream.read().includes(windowsLaunchMarker),
      label,
      WINDOWS_LAUNCH_WAIT,
    );
    return;
  }
  await waitForShellReady(stream, label);
}

async function main(): Promise<void> {
  ensureSpawnHelperExecutable();

  // The parent wrapper redirects the OS temp environment into its own
  // best-effort cleanup directory. Synchronous exit cleanup here can block on
  // Windows while a just-killed shell still holds this directory as its CWD.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pty-harness-')));

  // A real command runs and its evaluated output streams back,
  // and the prompt sits at the supplied project root.
  await scenario('real command round-trip at project root', async () => {
    const cwdToken = randomUUID();
    writeFileSync(join(tmp, CWD_PROOF_FILE), cwdToken, 'utf8');
    const host = createHost(BASE_ENV);
    const io = host.streamOf('io');
    const readiness = createWindowsReadinessLaunch();
    try {
      host.send({
        type: 'create',
        ptyId: 'io',
        cwd: tmp,
        cols: 80,
        rows: 24,
        ...(readiness === null ? {} : { launchCommand: readiness.launchCommand }),
      });
      await waitForInteractiveShellReady(
        host,
        'io',
        'interactive shell ready at project root',
        readiness?.marker ?? null,
      );
      // The arithmetic expression only resolves to 42 if the shell evaluated
      // it; the echoed input line keeps the literal expression.
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

  // Desktop-only markers are stripped from the user's shell.
  await scenario('strips desktop env markers from the shell', async () => {
    const host = createHost({
      ...BASE_ENV,
      OK_ELECTRON_PROTOCOL_HOST: '1',
      OK_LOCK_KIND: 'interactive',
    });
    const env = host.streamOf('env');
    const readiness = createWindowsReadinessLaunch();
    try {
      host.send({
        type: 'create',
        ptyId: 'env',
        cwd: tmp,
        cols: 80,
        rows: 24,
        ...(readiness === null ? {} : { launchCommand: readiness.launchCommand }),
      });
      await waitForInteractiveShellReady(
        host,
        'env',
        'interactive shell ready with desktop markers stripped',
        readiness?.marker ?? null,
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
    // This is the only real-shell proof whose structured PowerShell launch
    // carries meaningful argv beyond the readiness marker. The explicit
    // Windows PowerShell override is load-bearing; the package smoke
    // intentionally pins ComSpec/cmd instead. The host-survival scenario below
    // separately exercises the plain empty-argv Windows spawn path twice.
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
        // The launch rides in as composed argv, so the output wait below needs
        // no pre-write gate. A distinct command typed afterward proves the shell
        // remains interactive after the EncodedCommand returns.
        await waitForCondition(
          launch,
          () => launch.read().includes(launchToken),
          'PowerShell EncodedCommand output',
          WINDOWS_LAUNCH_WAIT,
        );
        const interactiveToken = `OK_INTERACTIVE_${randomUUID().replaceAll('-', '')}`;
        host.send({
          type: 'input',
          ptyId: 'launch',
          data: `${shellCommands.arithmetic(interactiveToken, 6, 7, 'READY')}\r`,
        });
        await waitForCondition(
          launch,
          () => launch.read().includes(`${interactiveToken}_42_READY`),
          'PowerShell remains interactive after EncodedCommand',
          WINDOWS_LAUNCH_WAIT,
        );
        if (host.errorOf('launch') !== null) {
          throw new Error(`PowerShell launch failed: ${host.errorOf('launch')}`);
        }
      } finally {
        host.killActive();
      }
    });
  }

  // Killing the shell (a crash) yields an exit event and the host stays
  // alive — a fresh PTY spawns in the same host.
  await scenario('host survives a PTY death and respawns', async () => {
    const host = createHost(BASE_ENV);
    const first = host.streamOf('c1');
    const second = host.streamOf('c2');
    host.send({ type: 'create', ptyId: 'c1', cwd: tmp, cols: 80, rows: 24 });
    // Neither shell here is driven with input, so "the PTY produced bytes" is
    // the whole claim — spawn liveness, not read-loop readiness.
    await waitForCondition(first, () => first.read().length > 0, 'first shell prompt');
    host.send({ type: 'kill', ptyId: 'c1' });
    await waitForCondition(first, () => host.exitOf('c1') !== null, 'exit after kill');
    host.send({ type: 'create', ptyId: 'c2', cwd: tmp, cols: 80, rows: 24 });
    await waitForCondition(
      second,
      () => second.read().length > 0,
      'second shell prompt (host survived)',
    );
    host.killActive();
  });

  // A shell that cannot launch surfaces through the host's failure channel.
  await scenario('bad shell surfaces as a spawn failure', async () => {
    const badShell = join(
      tmp,
      process.platform === 'win32' ? 'no-such-shell-xyz.exe' : 'no-such-shell-xyz',
    );
    // Windows validates configured shell paths before spawning. Admit this
    // deliberate missing-path fixture through that gate so node-pty, rather
    // than the fallback ladder, remains the dependency under test.
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

// Wedge backstop below the parent wrapper's independent deadline. Scenario
// budgets remain the source of normal timeout failures and their diagnostics.
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
