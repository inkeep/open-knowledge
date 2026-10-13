import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPosixCliLaunch,
  type TerminalLaunchCommand,
} from '@inkeep/open-knowledge-core/handoff';
import { afterEach, describe, expect, test } from 'vitest';
import { buildShellArgs } from '../../src/utility/pty-host.ts';
import { capturedTails, spawnSyncBounded } from '../support/bounded-sync-spawn.test-helper.ts';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper.ts';

const PRINTF = '/usr/bin/printf';
const ARGV_START = 'ok-launch-argv-start';

const HOSTILE_PROMPT = [
  "fish: x\\'(touch pwned-fish)\\'",
  'posix: $(touch pwned-posix) `touch pwned-tick`',
  "quote: '; touch pwned-quote #",
  'backslashes: \\\\ \\n \\',
  'control: a\u0003b',
].join('\n');

const SHELL_CANDIDATES = [
  '/bin/sh',
  '/bin/bash',
  '/bin/zsh',
  '/usr/bin/fish',
  '/usr/local/bin/fish',
  '/opt/homebrew/bin/fish',
];

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDirBestEffort(dir);
});

function writeProbeAliases(home: string): void {
  const posixAlias = `alias okprobe=${PRINTF}\n`;
  for (const rc of ['.bashrc', '.bash_profile', '.profile', '.shrc', '.zshrc']) {
    writeFileSync(join(home, rc), posixAlias);
  }
  mkdirSync(join(home, 'fish'), { recursive: true });
  writeFileSync(join(home, 'fish', 'config.fish'), `alias okprobe ${PRINTF}\n`);
}

function runLaunch(shell: string, launch: TerminalLaunchCommand) {
  const cwd = tempDir('ok-posix-launch-cwd-');
  const home = tempDir('ok-posix-launch-home-');
  writeProbeAliases(home);
  const run = spawnSyncBounded(shell, buildShellArgs(process.platform, shell, launch, []), {
    cwd,
    input: '',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      ENV: join(home, '.shrc'),
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      ZDOTDIR: home,
    },
    timeoutMs: 20_000,
  });
  return { cwd, run };
}

function receivedArgv(stdout: string, count: number): string[] | null {
  const start = stdout.indexOf(`${ARGV_START}\0`);
  if (start < 0) return null;
  return stdout
    .slice(start + ARGV_START.length + 1)
    .split('\0')
    .slice(0, count);
}

describe.skipIf(process.platform === 'win32' || !existsSync(PRINTF))(
  'a POSIX agent CLI launch run through the real login shell',
  () => {
    test.for(SHELL_CANDIDATES)(
      '%s hands the CLI the prompt as one argument and runs nothing in it',
      (shell, ctx) => {
        ctx.skip(!existsSync(shell), `${shell} is not installed`);
        const launch = buildPosixCliLaunch('claude', HOSTILE_PROMPT, {
          mcpPreApprove: true,
          autoApproveOkTools: true,
          mcpServerName: 'open-knowledge',
        });
        const { cwd, run } = runLaunch(shell, {
          executable: PRINTF,
          args: ['%s\\0', ARGV_START, ...launch.args],
        });

        const received = receivedArgv(run.stdout, launch.args.length);
        expect(received, capturedTails(run)).toEqual(launch.args);
        expect(received?.at(-1)).toContain("x\\'(touch pwned-fish)\\'");
        expect(readdirSync(cwd).filter((name) => name.startsWith('pwned-'))).toEqual([]);
      },
    );

    test.for(SHELL_CANDIDATES)(
      '%s still resolves an alias for the CLI command name',
      (shell, ctx) => {
        ctx.skip(!existsSync(shell), `${shell} is not installed`);
        const { run } = runLaunch(shell, {
          executable: 'okprobe',
          args: ['%s\\0', ARGV_START, 'hello world'],
        });

        expect(receivedArgv(run.stdout, 1), capturedTails(run)).toEqual(['hello world']);
      },
    );
  },
);
