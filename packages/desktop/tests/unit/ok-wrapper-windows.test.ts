/**
 * Windows sibling of `ok-wrapper.test.ts` — runs the shipped `ok.cmd` / `ok.ps1`
 * as real subprocesses and asserts the `ok-bundle-missing` contract.
 *
 * The POSIX wrappers (`ok.sh`, `ok-linux.sh`) were proven by execution; the
 * Windows pair only ever had config-shape coverage (that electron-builder ships
 * them, and that the paths they compute look right). They claim the SAME
 * two-line-stderr + exit-69 contract, so "same contract" was an assertion about
 * two files nobody had run. This closes that asymmetry.
 *
 * Windows-only by construction: `cmd.exe` and `powershell.exe` are the hosts
 * under test, so the suite skips elsewhere rather than faking them. It runs in
 * the `desktop-crossbuild` CI job's windows-latest cell.
 *
 * The lifecycle under test is drag-to-Trash-equivalent: an MCP client still
 * holds the wrapper path in its config after the app is uninstalled or moved.
 * The wrapper must self-diagnose (human line + machine-readable JSON line)
 * instead of failing with a raw shell error.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = resolve(__dirname, '..', '..', 'resources', 'cli', 'bin');

const WINDOWS = process.platform === 'win32';

const EXPECTED_HUMAN_LINE =
  'OpenKnowledge has been removed. Reinstall from the OpenKnowledge installer.';
const EXPECTED_JSON = {
  error: 'ok-bundle-missing',
  hint: 'OpenKnowledge app appears to have been removed. Reinstall it, or remove OK entries from your MCP config and rerun ok init.',
};

/**
 * Stage a wrapper into an install-shaped tree with NOTHING else in it.
 *
 * Both wrappers resolve the install root as `<script dir>\..\..\..`, so the
 * three intermediate directories must exist for their path math to land where
 * it does in a real install — but `OpenKnowledge.exe` and `cli\dist\cli.mjs`
 * are absent, which is exactly the removed-app state.
 */
function stageOrphanedWrapper(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-wrapper-win-'));
  const binDir = join(root, 'resources', 'cli', 'bin');
  mkdirSync(binDir, { recursive: true });
  const staged = join(binDir, name);
  copyFileSync(join(BIN_DIR, name), staged);
  return staged;
}

/** Split captured stderr into trimmed, non-empty lines. */
function stderrLines(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

describe.skipIf(!WINDOWS)('Windows ok wrapper bundle-missing contract', () => {
  test('ok.cmd emits two-line stderr and exits 69 when the install is gone', () => {
    const wrapper = stageOrphanedWrapper('ok.cmd');
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', wrapper], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(69);
    const lines = stderrLines(result.stderr);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(EXPECTED_HUMAN_LINE);
    expect(JSON.parse(lines[1] ?? '')).toEqual(EXPECTED_JSON);
  });

  test('ok.ps1 emits two-line stderr and exits 69 when the install is gone', () => {
    const wrapper = stageOrphanedWrapper('ok.ps1');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(69);
    const lines = stderrLines(result.stderr);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(EXPECTED_HUMAN_LINE);
    expect(JSON.parse(lines[1] ?? '')).toEqual(EXPECTED_JSON);
  });

  test('both wrappers agree on the stderr contract byte-for-byte', () => {
    const runs = [
      spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', stageOrphanedWrapper('ok.cmd')], {
        encoding: 'utf8',
      }),
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          stageOrphanedWrapper('ok.ps1'),
        ],
        { encoding: 'utf8' },
      ),
    ];
    const [cmdLines, ps1Lines] = runs.map((r) => stderrLines(r.stderr));
    // Divergence here is the failure the config-shape tests could never see:
    // two wrappers documented as interchangeable that an MCP client parsing
    // stderr would have to special-case.
    expect(cmdLines).toEqual(ps1Lines);
  });
});
