import { describe, expect, test } from 'bun:test';
import { extractOriginUrl as extractFromCli } from '../../../cli/src/github/folder-validator';
import { extractOriginUrl as extractFromServer } from '../../../server/src/share/git-context';
import { extractOriginUrl as extractFromDesktop } from '../../src/main/git-remote';

/**
 * Cross-package contract test for `[remote "origin"]` parsing.
 *
 * Three production sites duplicate this parser (server, desktop, CLI) to
 * avoid a server↔CLI dependency cycle. A regex divergence here previously
 * caused the server to reject configs with whitespace after the opening
 * bracket while the other two accepted them. This sync guard ensures all
 * three return identical output for a shared fixture set so a bug fix to
 * one copy can't silently fail to propagate.
 *
 * If extracting to a shared core helper becomes feasible (no cycle, no
 * extra public surface), this test can be deleted — the consolidated
 * implementation will be its own contract.
 */

interface Fixture {
  readonly name: string;
  readonly input: string;
  readonly expected: string | null;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'canonical HTTPS origin',
    input: '[remote "origin"]\n\turl = https://github.com/owner/repo.git\n',
    expected: 'https://github.com/owner/repo.git',
  },
  {
    name: 'SSH origin',
    input: '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n',
    expected: 'git@github.com:owner/repo.git',
  },
  {
    name: 'whitespace after opening bracket — `[ remote "origin"]`',
    input: '[ remote "origin" ]\n\turl = https://github.com/owner/repo.git\n',
    expected: 'https://github.com/owner/repo.git',
  },
  {
    name: 'single-quoted section header',
    input: "[remote 'origin']\n\turl = https://github.com/owner/repo.git\n",
    expected: 'https://github.com/owner/repo.git',
  },
  {
    name: 'inline comment after URL',
    input: '[remote "origin"]\n\turl = https://github.com/o/r.git ; legacy origin\n',
    expected: 'https://github.com/o/r.git',
  },
  {
    name: 'CRLF line endings',
    input: '[remote "origin"]\r\n\turl = https://github.com/o/r.git\r\n',
    expected: 'https://github.com/o/r.git',
  },
  {
    name: 'quoted URL value',
    input: '[remote "origin"]\n\turl = "https://github.com/o/r.git"\n',
    expected: 'https://github.com/o/r.git',
  },
  {
    name: 'absent origin section',
    input:
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/forky/spoon.git\n',
    expected: null,
  },
  {
    name: 'empty blob',
    input: '',
    expected: null,
  },
  {
    name: 'origin section with no url line',
    input: '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    expected: null,
  },
];

describe('git-config `[remote "origin"]` parser parity', () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const desktopResult = extractFromDesktop(fixture.input);
      const cliResult = extractFromCli(fixture.input);
      const serverResult = extractFromServer(fixture.input);

      expect(desktopResult).toBe(fixture.expected);
      expect(cliResult).toBe(fixture.expected);
      expect(serverResult).toBe(fixture.expected);

      // Cross-implementation equality — if any pair diverges, fail loudly
      // even when the expected fixture might already be the wrong value.
      expect(desktopResult).toBe(cliResult);
      expect(cliResult).toBe(serverResult);
    });
  }
});
