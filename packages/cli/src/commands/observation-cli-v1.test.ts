import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const packageRoot = import.meta.dir.replace(/\/src\/commands$/, '');
let projectDir: string;

function invoke(args: string[], cwd = projectDir) {
  const result = Bun.spawnSync({
    cmd: ['node', '--import', 'tsx', '--conditions=development', 'src/cli.ts', ...args],
    cwd: packageRoot,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
    cwd,
  };
}

function atProject(command: 'status' | 'ps', args: string[]) {
  return invoke(['--cwd', projectDir, command, ...args]);
}

describe('observation CLI v1 captured process', () => {
  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-observation-v1-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), '{}\n');
  });
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  test.each(['status', 'ps'] as const)(
    '%s accepts both v1 spellings with one newline terminated object',
    (command) => {
      for (const args of [['--format', 'json-v1'], ['--format=json-v1']]) {
        const result = atProject(command, args);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.endsWith('\n')).toBe(true);
        expect(result.stdout.endsWith('\n\n')).toBe(false);
        const document = JSON.parse(result.stdout);
        expect(document).toMatchObject({ schemaVersion: 1, command, result: { kind: 'success' } });
        expect(result.stdout).toBe(`${JSON.stringify(document)}\n`);
        if (command === 'status') {
          expect(document.server).toMatchObject({
            lock: { state: 'missing' },
            readiness: { status: 'not-running' },
            runtime: null,
          });
        } else {
          expect(Array.isArray(document.servers)).toBe(true);
        }
      }
    },
    120_000,
  );

  test('ps inventories independently of malformed project config', () => {
    const configPath = join(projectDir, '.ok', 'config.yml');
    writeFileSync(configPath, 'server:\n  port: 99999999\n');
    try {
      const result = atProject('ps', ['--format', 'json-v1']);
      expect(result.exitCode).toBe(0);
      const document = JSON.parse(result.stdout);
      expect(document.result).toMatchObject({ kind: 'success', code: 'inventoried' });
      expect(Array.isArray(document.servers)).toBe(true);
      const status = atProject('status', ['--format', 'json-v1']);
      expect(JSON.parse(status.stdout).result.code).toBe('project-unavailable');
    } finally {
      writeFileSync(configPath, '{}\n');
    }
  }, 60_000);

  test.each(['status', 'ps'] as const)(
    '%s parser errors emit no document',
    (command) => {
      for (const args of [
        ['--format', 'yaml'],
        ['--format'],
        ['--format', 'json-v1', '--json'],
        ['--json', '--format', 'json-v1'],
        ['--unknown'],
      ]) {
        const result = atProject(command, args);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr.length).toBeGreaterThan(0);
      }
    },
    120_000,
  );

  test.each(['status', 'ps'] as const)(
    '%s structures established project failure',
    (command) => {
      const result = invoke(['--cwd', join(projectDir, 'missing'), command, '--format', 'json-v1']);
      expect(result.exitCode).toBe(1);
      const document = JSON.parse(result.stdout);
      expect(result.stdout).toBe(`${JSON.stringify(document)}\n`);
      expect(document.command).toBe(command);
      expect(document.result).toMatchObject({
        kind: 'error',
        code: command === 'status' ? 'project-unavailable' : 'operation-failed',
      });
      if (command === 'status')
        expect(document.project).toEqual({ root: null, resolution: 'unavailable' });
      else expect(document.servers).toEqual([]);
    },
    60_000,
  );

  test('legacy status text and --json keep their bytes', () => {
    expect(atProject('status', []).stdout).toBe('server  not running\nui      not running\n');
    const legacy = atProject('status', ['--json']);
    expect(legacy.stdout).toBe(
      `${JSON.stringify(
        {
          server: { name: 'server', state: 'missing', alive: false },
          ui: { name: 'ui', state: 'missing', alive: false },
        },
        null,
        2,
      )}\n`,
    );
  }, 60_000);

  test('legacy ps JSON remains an array and all modifiers match in v1', () => {
    const legacy = atProject('ps', ['--json']);
    expect(legacy.exitCode).toBe(0);
    expect(legacy.stdout).toBe('[]\n');
    expect(atProject('ps', []).stdout).toBe('No open-knowledge servers found.\n');
    const all = atProject('ps', ['all', '--format', 'json-v1']);
    const flag = atProject('ps', ['--all', '--format', 'json-v1']);
    expect(JSON.parse(all.stdout)).toEqual(JSON.parse(flag.stdout));
  }, 60_000);
});
