import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINAL_CLI_IDS, TERMINAL_CLIS } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const desktopLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../src/main/desktop-logger.ts', () => ({ getLogger: () => desktopLog }));

import {
  cliProbeArgs,
  type ProbeSpawn,
  type ProbeTimers,
  probePlatformCliOnPath,
  resolvePlatformCliInstalledMap,
  runLoginShellProbe,
} from '../../src/main/claude-readiness.ts';
import { handleSlidesStatus } from '../../src/main/ipc/slides.ts';
import { realProbeSpawn, realProbeTimers } from '../../src/main/probe-spawn.ts';
import {
  buildSlidevInvocation,
  composeSlidevSpawnEnv,
  findFreePort,
  realSpawnSlidev,
  type SlidevProcess,
} from '../../src/main/slidev-server.ts';
import { buildShellEnv } from '../../src/utility/pty-host.ts';
import {
  createRecordDir,
  createScratchHomeWithOkBin,
  firstShellOnDisk,
  MINIMAL_PARENT_PATH,
  RC_WITHOUT_MANAGED_BLOCK,
} from '../support/ok-bin-scratch-home.test-helper.ts';

const SENTINEL_EXIT_CODE = 42;
const SLIDEV_BIN = 'slidev';
const TERMINAL_CLI_BINS = TERMINAL_CLI_IDS.map((cli) => TERMINAL_CLIS[cli].bin);
const FIXTURE_ONLY_BIN = `ok-probe-fixture-${randomUUID()}`;
const CHILD_PATH_RECORD = "child's-path";
const BIN_ON_THE_BARE_PARENT_PATH = 'ls';
const LAUNCH_EXIT_TIMEOUT_MS = 20_000;
const LAUNCH_TIMED_OUT = -1;

const WHY_THIS_PAIRS_WITH_PTY_HOST =
  'Pairs with "prepends ~/.ok/bin to the child PATH so ok resolves regardless of rc consent" in ' +
  'packages/desktop/tests/utility/pty-host.test.ts. That test pins the producer (buildShellEnv). ' +
  'This file pins the consumers. The asserted directory is read back out of buildShellEnv rather ' +
  'than written as a literal, so the two halves cannot drift apart silently.';

const probeTimers: ProbeTimers = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
};

function bareEnvProbeSpawn(): ProbeSpawn {
  return (file, args) => {
    const child = spawn(file, [...args], { stdio: 'ignore', shell: false, windowsHide: true });
    return {
      onExit: (cb) => {
        child.on('exit', (code) => cb(code));
      },
      onError: (cb) => {
        child.on('error', (err) => cb(err));
      },
      kill: () => {
        child.kill('SIGKILL');
      },
    };
  };
}

function recordingProbeSpawn(inner: ProbeSpawn, probedArgv: string[][]): ProbeSpawn {
  return (file, args) => {
    probedArgv.push([file, ...args]);
    return inner(file, args);
  };
}

describe.skipIf(process.platform === 'win32')(
  'the CLI-presence probes and the Slidev launch run with ~/.ok/bin on their PATH',
  () => {
    let scratchHome: string;
    let recordDir: string;
    let childPathRecord: string;
    let shell: string;
    let previousHome: string | undefined;
    let previousPath: string | undefined;
    let previousZdotdir: string | undefined;

    beforeAll(() => {
      recordDir = createRecordDir();
      childPathRecord = join(recordDir, CHILD_PATH_RECORD);
      scratchHome = createScratchHomeWithOkBin({
        prefix: 'ok-bin-child-path-',
        bins: [SLIDEV_BIN, ...TERMINAL_CLI_BINS, FIXTURE_ONLY_BIN],
        exitCode: SENTINEL_EXIT_CODE,
        recordPath: childPathRecord,
      });
      previousHome = process.env.HOME;
      previousPath = process.env.PATH;
      previousZdotdir = process.env.ZDOTDIR;
      process.env.HOME = scratchHome;
      process.env.PATH = MINIMAL_PARENT_PATH;
      delete process.env.ZDOTDIR;
      shell = firstShellOnDisk();
    });

    afterAll(() => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousZdotdir !== undefined) process.env.ZDOTDIR = previousZdotdir;
      rmSync(scratchHome, { recursive: true, force: true });
      rmSync(recordDir, { recursive: true, force: true });
    });

    function appGrantedShellEnv(): NodeJS.ProcessEnv {
      return buildShellEnv(process.env, { platform: process.platform }).env;
    }

    function okBinGrantedToOwnShells(): string {
      return (appGrantedShellEnv().PATH ?? '').split(':')[0] ?? '';
    }

    function probeThroughBareEnv(bin: string): Promise<number | null> {
      return runLoginShellProbe(
        bareEnvProbeSpawn(),
        shell,
        probeTimers,
        undefined,
        cliProbeArgs(bin, process.platform),
      );
    }

    async function expectBareEnvAdapterWorks(): Promise<void> {
      expect(
        await probeThroughBareEnv(BIN_ON_THE_BARE_PARENT_PATH),
        'the bare-env probe adapter cannot resolve a binary that is on the parent PATH, so every negative result it produces is vacuous',
      ).toBe(0);
    }

    test('the PATH OK Desktop grants its own shells leads with ~/.ok/bin', () => {
      expect(okBinGrantedToOwnShells(), WHY_THIS_PAIRS_WITH_PTY_HOST).toBe(
        join(scratchHome, '.ok', 'bin'),
      );
    });

    test('a probe child inheriting the bare app environment misses a ~/.ok/bin CLI the production seam resolves', async () => {
      expect(
        await runLoginShellProbe(
          realProbeSpawn,
          shell,
          realProbeTimers,
          undefined,
          cliProbeArgs(FIXTURE_ONLY_BIN, process.platform),
        ),
        'the fixture bin is not a working sentinel, so the negative half below is vacuous',
      ).toBe(0);
      await expectBareEnvAdapterWorks();
      expect(await probeThroughBareEnv(FIXTURE_ONLY_BIN)).not.toBe(0);
    });

    test('every CLI-presence detection site reports a ~/.ok/bin CLI present, through one probe-spawn seam', async () => {
      const probedArgv: string[][] = [];
      const probeSpawn = recordingProbeSpawn(realProbeSpawn, probedArgv);
      const platform = process.platform;
      const probePosix = (args: readonly string[]) =>
        runLoginShellProbe(probeSpawn, shell, realProbeTimers, undefined, args);
      const probeWindows = () => Promise.resolve(null);

      const slidesStatus = await handleSlidesStatus(undefined, {
        isExecutableFile: () => Promise.resolve(false),
        isOnLoginPath: async (bin) => (await probePosix(cliProbeArgs(bin, platform))) === 0,
      });
      const claudeReadiness = await probePlatformCliOnPath({
        platform,
        bin: TERMINAL_CLIS.claude.bin,
        probePosix,
        probeWindows,
      });
      const codexOnPath = await probePlatformCliOnPath({
        platform,
        bin: TERMINAL_CLIS.codex.bin,
        probePosix,
        probeWindows,
      });
      const installedMap = await resolvePlatformCliInstalledMap({
        platform,
        probePosix,
        probeWindows,
      });

      expect(slidesStatus).toEqual({ kind: 'status', available: true, source: 'global' });
      expect(claudeReadiness).toBe(0);
      expect(codexOnPath).toBe(0);
      expect(installedMap).toEqual(Object.fromEntries(TERMINAL_CLI_IDS.map((cli) => [cli, true])));
      expect(probedArgv.every(([file]) => file === shell)).toBe(true);
      expect(new Set(probedArgv.map((argv) => argv.at(-1)))).toEqual(
        new Set(
          [SLIDEV_BIN, ...TERMINAL_CLI_BINS].map((bin) => cliProbeArgs(bin, platform).at(-1)),
        ),
      );
    });

    describe('the Slidev launch child', () => {
      let launched: SlidevProcess | undefined;
      let launchExitCode: number | null = LAUNCH_TIMED_OUT;

      beforeAll(async () => {
        await expectBareEnvAdapterWorks();
        if ((await probeThroughBareEnv(SLIDEV_BIN)) === 0) {
          throw new Error(
            'the scratch HOME is compromised: a slidev outside ~/.ok/bin is already reachable from the bare app environment',
          );
        }
        const projectRoot = mkdtempSync(join(tmpdir(), 'ok-bin-child-path-deck-'));
        const child = realSpawnSlidev(
          { docPath: join(projectRoot, 'slides.md'), shell, source: 'global', projectRoot },
          await findFreePort(),
        );
        launched = child;
        launchExitCode = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => resolve(LAUNCH_TIMED_OUT), LAUNCH_EXIT_TIMEOUT_MS);
          child.onExit((code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
      }, LAUNCH_EXIT_TIMEOUT_MS + 15_000);

      afterAll(async () => {
        if (launched?.isAlive() === true) await launched.signal('SIGKILL');
      });

      test('runs the slidev installed in ~/.ok/bin', () => {
        expect(
          launchExitCode,
          launchExitCode === LAUNCH_TIMED_OUT
            ? 'the launched slidev never exited: it resolved to something other than the ~/.ok/bin sentinel'
            : 'the launched slidev is not the ~/.ok/bin sentinel',
        ).toBe(SENTINEL_EXIT_CODE);
      });

      test('leaves a record of the environment it actually ran with', () => {
        expect(
          existsSync(childPathRecord),
          'the launched slidev was the sentinel (it exited with the sentinel code) but wrote no record, so the PATH assertion below would report a harness failure as a PATH failure',
        ).toBe(true);
      });

      test('runs with ~/.ok/bin on its PATH', () => {
        const recorded = readFileSync(childPathRecord, 'utf8');
        expect(recorded.split(':'), WHY_THIS_PAIRS_WITH_PTY_HOST).toContain(
          okBinGrantedToOwnShells(),
        );
      });

      test('records the shell command family on the launch record, which firstShellOnDisk always resolves to posix', () => {
        expect(
          desktopLog.info.mock.calls.map(([attrs]) => attrs as Record<string, unknown>),
          'the launch is the only one of the shell-family consumers whose record is emitted from a real spawn, so nothing else would notice if the key drifted; firstShellOnDisk only ever returns /bin/zsh, /bin/bash or /bin/sh, every one of which shellCommandFamily classifies posix',
        ).toContainEqual(
          expect.objectContaining({
            event: 'slides-launch-shell-resolved',
            platform: process.platform,
            shellCommandFamily: 'posix',
          }),
        );
      });
    });
  },
);

function spawnDeck(
  shell: string,
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) {
  const child = spawn(shell, [...args.slice(0, -1), command], {
    stdio: 'ignore',
    detached: true,
    ...(env ? { env } : {}),
  });
  const shellPid = child.pid ?? 0;
  const descendants = () =>
    spawnSync('/bin/ps', ['-eo', 'pid,ppid,pgid'], { encoding: 'utf8' })
      .stdout.split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row.length === 3 && row[1] === shellPid);
  const reap = () => {
    for (const [pid] of descendants()) {
      try {
        process.kill(pid ?? 0, 'SIGKILL');
      } catch {}
    }
    try {
      process.kill(-shellPid, 'SIGKILL');
    } catch {}
  };
  return { shellPid, descendants, reap };
}

const FISH_SHELL_CANDIDATES = [
  '/opt/homebrew/bin/fish',
  '/usr/local/bin/fish',
  '/usr/bin/fish',
] as const;
const FISH_SHELL = FISH_SHELL_CANDIDATES.find((bin) => existsSync(bin));
const FISH_DECK_APPEAR_TIMEOUT_MS = 15_000;
const FISH_DECK_REAP_TIMEOUT_MS = 5_000;
const FISH_CONTAINMENT_TIMEOUT_MS =
  FISH_DECK_APPEAR_TIMEOUT_MS * 2 + FISH_DECK_REAP_TIMEOUT_MS + 15_000;

describe.skipIf(!existsSync('/bin/bash'))('Slidev launch process-group containment', () => {
  test('the launched deck shares the spawned shell process group, so the group kill reaches it', async (ctx) => {
    const deckDir = mkdtempSync(join(tmpdir(), 'ok-pgid-'));
    try {
      const invocation = buildSlidevInvocation(
        {
          source: 'global',
          projectRoot: deckDir,
          docPath: join(deckDir, 'slides.md'),
          shell: '/bin/bash',
        },
        4300,
        'linux',
        [join(deckDir, '.ok', 'bin')],
      );
      const shipped = `${invocation.args.at(-1)?.replace(/slidev .*$/, '/bin/sleep 60')}; :`;
      const mutated = shipped.replace('set +m; ', '');
      expect(shipped).toContain('set +m; ');
      expect(mutated).not.toContain('set +m; ');

      const control = spawnDeck('/bin/bash', mutated, invocation.args, {
        ...process.env,
        HOME: deckDir,
      });
      try {
        await vi.waitFor(() => expect(control.descendants().length).toBeGreaterThan(0), {
          timeout: 5_000,
        });
        const [mutantDeck] = control.descendants();
        if (mutantDeck?.[2] === control.shellPid) {
          const version =
            spawnSync('/bin/bash', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0] ?? '';
          ctx.skip(
            `this host's bash keeps the deck in the shell group even without 'set +m', so it cannot witness the leak: ${version}`,
          );
          return;
        }
      } finally {
        control.reap();
      }

      const shippedRun = spawnDeck('/bin/bash', shipped, invocation.args, {
        ...process.env,
        HOME: deckDir,
      });
      try {
        await vi.waitFor(() => expect(shippedRun.descendants().length).toBeGreaterThan(0), {
          timeout: 5_000,
        });
        const [deck] = shippedRun.descendants();
        expect(
          deck?.[2],
          "bash turns job control on from -i alone and then setpgid()s the deck into its own group, where signalSlidevChild's process.kill(-pid) cannot reach it",
        ).toBe(shippedRun.shellPid);
        const deckPid = deck?.[0] ?? 0;
        process.kill(-shippedRun.shellPid, 'SIGKILL');
        await vi.waitFor(
          () => {
            expect(() => process.kill(deckPid, 0)).toThrow();
          },
          { timeout: 5_000 },
        );
      } finally {
        shippedRun.reap();
      }
    } finally {
      rmSync(deckDir, { recursive: true, force: true });
    }
  });
});

describe('Slidev launch process-group containment on fish', () => {
  test(
    'the fish job-control opt-out keeps the deck in the shell process group even when config.fish turned job control on',
    async (ctx) => {
      if (FISH_SHELL === undefined) {
        ctx.skip(
          `no fish binary at any of ${FISH_SHELL_CANDIDATES.join(', ')}, so fish containment is UNKNOWN on this host rather than confirmed: the bash arm above degrades this way too, and a silently absent describe would read like a pass in the run summary`,
        );
        return;
      }
      const fish = FISH_SHELL;
      const deckDir = mkdtempSync(join(tmpdir(), 'ok-pgid-fish-'));
      try {
        mkdirSync(join(deckDir, '.config', 'fish'), { recursive: true });
        writeFileSync(
          join(deckDir, '.config', 'fish', 'config.fish'),
          'status job-control full\n',
          'utf8',
        );
        const invocation = buildSlidevInvocation(
          {
            source: 'global',
            projectRoot: deckDir,
            docPath: join(deckDir, 'slides.md'),
            shell: fish,
          },
          4300,
          'linux',
          [join(deckDir, '.ok', 'bin')],
        );
        const shipped = `${invocation.args.at(-1)?.replace(/slidev .*$/, '/bin/sleep 60')}; true`;
        const mutated = shipped.replace('status job-control none; ', '');
        expect(shipped).toContain('status job-control none; ');
        expect(mutated).not.toContain('status job-control none');
        expect(
          shipped,
          'fish speaks its own job-control builtin, so the POSIX opt-out would be a command-not-found in the same position',
        ).not.toContain('set +m');

        const fishEnv = {
          ...process.env,
          HOME: deckDir,
          XDG_CONFIG_HOME: join(deckDir, '.config'),
        };
        const control = spawnDeck(fish, mutated, invocation.args, fishEnv);
        try {
          await vi.waitFor(() => expect(control.descendants().length).toBeGreaterThan(0), {
            timeout: FISH_DECK_APPEAR_TIMEOUT_MS,
          });
          const [mutantDeck] = control.descendants();
          if (mutantDeck?.[2] === control.shellPid) {
            const version = spawnSync(fish, ['--version'], { encoding: 'utf8' }).stdout.trim();
            ctx.skip(
              `this host's fish keeps the deck in the shell group even at 'status job-control full' with the opt-out stripped, so it cannot witness the leak: ${version}`,
            );
            return;
          }
        } finally {
          control.reap();
        }

        const shippedRun = spawnDeck(fish, shipped, invocation.args, fishEnv);
        try {
          await vi.waitFor(() => expect(shippedRun.descendants().length).toBeGreaterThan(0), {
            timeout: FISH_DECK_APPEAR_TIMEOUT_MS,
          });
          const [deck] = shippedRun.descendants();
          expect(
            deck?.[2],
            `a config.fish carrying 'status job-control full' survives into ${fish} -i -c, where it setpgid()s the deck into its own group and signalSlidevChild's process.kill(-pid) cannot reach it, so the opt-out has to land after startup files rather than in the env layer`,
          ).toBe(shippedRun.shellPid);
          const deckPid = deck?.[0] ?? 0;
          process.kill(-shippedRun.shellPid, 'SIGKILL');
          await vi.waitFor(
            () => {
              expect(() => process.kill(deckPid, 0)).toThrow();
            },
            { timeout: FISH_DECK_REAP_TIMEOUT_MS },
          );
        } finally {
          shippedRun.reap();
        }
      } finally {
        rmSync(deckDir, { recursive: true, force: true });
      }
    },
    FISH_CONTAINMENT_TIMEOUT_MS,
  );
});

describe.skipIf(!existsSync('/bin/bash'))('Slidev bashrc function detect-and-launch parity', () => {
  test('a slidev function defined only in ~/.bashrc is both detected and launchable', async () => {
    const home = createScratchHomeWithOkBin({ prefix: 'ok-bashrc-fn-', bins: [] });
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    try {
      writeFileSync(join(home, '.bashrc'), `slidev() { exit ${SENTINEL_EXIT_CODE}; }\n`);
      for (const loginOnly of ['.bash_profile', '.profile']) {
        writeFileSync(join(home, loginOnly), RC_WITHOUT_MANAGED_BLOCK);
      }
      process.env.HOME = home;
      process.env.PATH = MINIMAL_PARENT_PATH;
      expect(
        await runLoginShellProbe(
          realProbeSpawn,
          '/bin/bash',
          realProbeTimers,
          undefined,
          cliProbeArgs('slidev', 'linux'),
        ),
      ).toBe(0);
      const invocation = buildSlidevInvocation(
        {
          source: 'global',
          projectRoot: home,
          docPath: join(home, 'slides.md'),
          shell: '/bin/bash',
        },
        4300,
        'linux',
        [],
      );
      const child = spawnSync(invocation.file, [...invocation.args], {
        env: { ...process.env, HOME: home, PATH: MINIMAL_PARENT_PATH },
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(SENTINEL_EXIT_CODE);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('Slidev shell startup PATH replacement', () => {
  test('reasserts the managed CLI path for detection and launch after shell startup', async () => {
    const home = createScratchHomeWithOkBin({
      prefix: 'ok-bin-login-reset-',
      bins: ['slidev'],
      exitCode: SENTINEL_EXIT_CODE,
    });
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    try {
      const shellDir = join(home, 'path-reset-shell');
      mkdirSync(shellDir, { recursive: true });
      const shell = join(shellDir, 'bash');
      writeFileSync(
        shell,
        '#!/bin/sh\nfor last do :; done\nPATH=/usr/bin:/bin\nexport PATH\nexec /bin/sh -c "$last"\n',
      );
      chmodSync(shell, 0o755);
      const env = composeSlidevSpawnEnv(
        { HOME: home, PATH: MINIMAL_PARENT_PATH },
        { platform: 'linux', home },
        () => false,
      );
      const login = spawnSync(shell, ['-l', '-i', '-c', 'exec slidev'], {
        env,
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(login.error).toBeUndefined();
      expect(login.status).not.toBe(0);
      process.env.HOME = home;
      process.env.PATH = MINIMAL_PARENT_PATH;
      expect(
        await runLoginShellProbe(
          realProbeSpawn,
          shell,
          realProbeTimers,
          undefined,
          cliProbeArgs('slidev', 'linux'),
        ),
      ).toBe(0);
      const invocation = buildSlidevInvocation(
        {
          source: 'global',
          projectRoot: home,
          docPath: join(home, 'slides.md'),
          shell,
        },
        4300,
        'linux',
        [join(home, '.ok', 'bin')],
      );
      expect(invocation.mode).toBe('interactive-shell');
      const child = spawnSync(invocation.file, [...invocation.args], {
        env,
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(SENTINEL_EXIT_CODE);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
