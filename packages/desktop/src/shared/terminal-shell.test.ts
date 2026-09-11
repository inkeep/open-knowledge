import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { commandWithManagedPath } from './terminal-shell.ts';

const zsh = ['/bin/zsh', '/usr/bin/zsh'].find(existsSync);
const bash = ['/bin/bash', '/usr/bin/bash'].find(existsSync);

describe.skipIf(zsh === undefined)('commandWithManagedPath', () => {
  test('keeps startup-defined functions available in the initialized shell', () => {
    const zdotdir = mkdtempSync(join(tmpdir(), 'ok-managed-path-zsh-'));
    try {
      writeFileSync(join(zdotdir, '.zshrc'), 'slidev() { exit 42; }\n');
      const command = commandWithManagedPath(zsh ?? '/bin/zsh', 'slidev deck.md --port 4300', [
        '/managed/bin',
      ]);
      const child = spawnSync(zsh ?? '/bin/zsh', ['-i', '-c', command], {
        env: { ...process.env, ZDOTDIR: zdotdir },
        encoding: 'utf8',
      });
      expect(child.status, child.stderr).toBe(42);
    } finally {
      rmSync(zdotdir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(bash === undefined)('commandWithManagedPath in Bash', () => {
  test('launches a function accepted by the presence probe', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-managed-path-bash-'));
    try {
      writeFileSync(join(home, '.bashrc'), 'slidev() { exit 43; }\n');
      const shell = bash ?? '/bin/bash';
      const command = commandWithManagedPath(shell, 'slidev deck.md --port 4300', ['/managed/bin']);
      const child = spawnSync(shell, ['-i', '-c', command], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      expect(child.status, child.stderr).toBe(43);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('commandWithManagedPath with no managed bin dir', () => {
  test.each([
    ['posix', '/bin/zsh'],
    ['fish', '/usr/bin/fish'],
    ['unrecognized', '/usr/bin/nu'],
  ])(
    'returns the command untouched for a %s shell, wrapping nothing around it',
    (_family, shell) => {
      const command = 'slidev deck.md --port 4300';
      expect(
        commandWithManagedPath(shell, command, []),
        'there is no reassert to carry when no dir resolves, and posixReassert([], cmd) is a syntax error, so the early return is the contract rather than an optimization',
      ).toBe(command);
    },
  );
});
