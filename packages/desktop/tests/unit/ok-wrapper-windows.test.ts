import { spawnSync } from 'node:child_process';

const WRAPPER_SPAWN_TIMEOUT_MS = 90_000;

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

function stageOrphanedWrapper(name: string, stagedName = name): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-wrapper-win-'));
  const binDir = join(root, 'resources', 'cli', 'bin');
  mkdirSync(binDir, { recursive: true });
  const staged = join(binDir, stagedName);
  copyFileSync(join(BIN_DIR, name), staged);
  return staged;
}

function envWithoutChannel(): NodeJS.ProcessEnv {
  const { OK_CHANNEL: _ignored, ...rest } = process.env;
  return rest;
}

function stderrLines(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

describe.skipIf(!WINDOWS)('Windows ok wrapper bundle-missing contract', () => {
  test('ok.cmd emits two-line stderr and exits 69 when the install is gone', () => {
    const wrapper = stageOrphanedWrapper('ok.cmd');
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', wrapper], {
      encoding: 'utf8',
      env: envWithoutChannel(),
      timeout: WRAPPER_SPAWN_TIMEOUT_MS,
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
      { encoding: 'utf8', env: envWithoutChannel(), timeout: WRAPPER_SPAWN_TIMEOUT_MS },
    );

    expect(result.status).toBe(69);
    const lines = stderrLines(result.stderr);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(EXPECTED_HUMAN_LINE);
    expect(JSON.parse(lines[1] ?? '')).toEqual(EXPECTED_JSON);
  });

  const BETA_JSON = {
    ...EXPECTED_JSON,
    hint: 'OpenKnowledge app appears to have been removed. Reinstall it, or remove OK entries from your MCP config and rerun ok-beta init.',
  };

  test('both wrappers agree byte-for-byte and name ok-beta init when installed under Beta names', () => {
    const runs = [
      spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/c', stageOrphanedWrapper('ok.cmd', 'ok-beta.cmd')],
        {
          encoding: 'utf8',
          env: envWithoutChannel(),
          timeout: WRAPPER_SPAWN_TIMEOUT_MS,
        },
      ),
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          stageOrphanedWrapper('ok.ps1', 'ok-beta.ps1'),
        ],
        { encoding: 'utf8', env: envWithoutChannel(), timeout: WRAPPER_SPAWN_TIMEOUT_MS },
      ),
    ];
    const [cmdLines, ps1Lines] = runs.map((r) => stderrLines(r.stderr));
    expect(cmdLines).toEqual(ps1Lines);
    for (const result of runs) {
      expect(result.status).toBe(69);
      expect(JSON.parse(stderrLines(result.stderr)[1] ?? '')).toEqual(BETA_JSON);
    }
  });
});
