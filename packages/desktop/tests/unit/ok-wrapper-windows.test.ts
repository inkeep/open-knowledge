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

function stageOrphanedWrapper(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-wrapper-win-'));
  const binDir = join(root, 'resources', 'cli', 'bin');
  mkdirSync(binDir, { recursive: true });
  const staged = join(binDir, name);
  copyFileSync(join(BIN_DIR, name), staged);
  return staged;
}

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
    expect(cmdLines).toEqual(ps1Lines);
  });
});
