import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const packageRoot = import.meta.dir.replace(/\/src\/commands$/, '');
let projectDir: string;

function invoke(command: 'stop' | 'clean', args: string[], cwd = projectDir) {
  const result = Bun.spawnSync({
    cmd: [
      'node',
      '--import',
      'tsx',
      '--conditions=development',
      'src/cli.ts',
      '--cwd',
      cwd,
      command,
      ...args,
    ],
    cwd: packageRoot,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe('mutation CLI v1 captured process', () => {
  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-mutation-v1-'));
    mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), '{}\n');
  });
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  test.each(['stop', 'clean'] as const)(
    '%s emits one complete object for both format spellings',
    (command) => {
      for (const format of [['--format', 'json-v1'], ['--format=json-v1']]) {
        const result = invoke(command, format);
        expect(result.exitCode).toBe(0);
        const document = JSON.parse(result.stdout);
        expect(result.stdout).toBe(`${JSON.stringify(document)}\n`);
        expect(document).toMatchObject({ schemaVersion: 1, command, result: { kind: 'no-op' } });
        expect(document.targets).toHaveLength(1);
        expect(document.targets[0].lockPath).toBe(join(projectDir, '.ok', 'local', 'server.lock'));
        expect(document.result.detail === null || typeof document.result.detail === 'string').toBe(
          true,
        );
      }
    },
    120_000,
  );

  test.each(['stop', 'clean'] as const)(
    '%s parser errors emit no document',
    (command) => {
      for (const args of [['--format', 'yaml'], ['--format'], ['--json'], ['--unknown']]) {
        const result = invoke(command, args);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr.length).toBeGreaterThan(0);
      }
    },
    120_000,
  );

  test.each(['stop', 'clean'] as const)(
    '%s structures project failure',
    (command) => {
      const result = invoke(command, ['--format', 'json-v1'], join(projectDir, 'missing'));
      expect(result.exitCode).toBe(1);
      const document = JSON.parse(result.stdout);
      expect(result.stdout).toBe(`${JSON.stringify(document)}\n`);
      expect(document.result).toMatchObject({ kind: 'error', code: 'project-unavailable' });
      expect(document.targets).toEqual([]);
    },
    60_000,
  );

  test('default text stays unchanged for missing locks', () => {
    expect(invoke('clean', []).stdout).toBe('No stale locks.\n');
    expect(invoke('stop', [projectDir]).stdout).toContain(`Nothing was running for ${projectDir}`);
  }, 60_000);

  test('stop refuses an unverified live owner even with force', () => {
    writeFileSync(
      join(projectDir, '.ok', 'local', 'server.lock'),
      JSON.stringify({ pid: process.pid, port: 4242 }),
    );
    try {
      const result = invoke('stop', ['--force', '--format', 'json-v1']);
      const document = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(document.result).toMatchObject({ kind: 'refused', code: 'ownership-unverified' });
      expect(document.force).toBe(true);
      expect(document.targets[0].pid).toBe(process.pid);
    } finally {
      rmSync(join(projectDir, '.ok', 'local', 'server.lock'), { force: true });
    }
  }, 60_000);
});
