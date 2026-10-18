import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const CLI_PACKAGE_ROOT = import.meta.dir.replace(/\/src$/, '');

describe('CLI argv parsing', () => {
  test('uses node argv slicing when launched by Electron as Node', () => {
    const result = Bun.spawnSync({
      cmd: [
        'node',
        '--import',
        'tsx',
        '--conditions=development',
        '-e',
        `
        Object.defineProperty(process.versions, 'electron', {
          value: '35.0.0',
          configurable: true,
        });
        process.argv = [
          process.execPath,
          process.cwd() + '/src/cli.ts',
          'ps',
          '--json',
        ];
        await import('./src/cli.ts');
        `,
      ],
      cwd: CLI_PACKAGE_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
    });

    const stderr = result.stderr.toString();
    const stdout = result.stdout.toString().trim();

    expect(result.exitCode).toBe(0);
    expect(stderr).not.toContain('unknown option');
    expect(stdout.startsWith('[')).toBe(true);
  }, 30_000);
});

describe('ok ui tombstone', () => {
  test('`ok ui` prints the removal pointer and exits non-zero (not the default-command arity error)', () => {
    const result = Bun.spawnSync({
      cmd: [
        'node',
        '--import',
        'tsx',
        '--conditions=development',
        '-e',
        `
        process.argv = [process.execPath, process.cwd() + '/src/cli.ts', 'ui', '--port', '39847'];
        await import('./src/cli.ts');
        `,
      ],
      cwd: CLI_PACKAGE_ROOT,
      env: { ...process.env, NO_COLOR: '1', OK_CHANNEL: 'stable' },
    });

    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain('`ok ui` was removed');
    expect(stderr).toContain('ok start');
    expect(stderr).not.toContain('too many arguments');
  }, 30_000);
});

function runCliSource(args: readonly string[], channel: 'stable' | 'beta') {
  return Bun.spawnSync({
    cmd: [
      'node',
      '--import',
      'tsx',
      '--conditions=development',
      '-e',
      `
      process.argv = [process.execPath, process.cwd() + '/src/cli.ts', ...${JSON.stringify(args)}];
      await import('./src/cli.ts');
      `,
    ],
    cwd: CLI_PACKAGE_ROOT,
    env: { ...process.env, NO_COLOR: '1', OK_CHANNEL: channel },
  });
}

describe('CLI names the running channel command', () => {
  test('Stable --help keeps its program name and examples', () => {
    const result = runCliSource(['--help'], 'stable');
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Usage: open-knowledge [options] [file | command]');
    expect(stdout).toContain(
      '  ok notes.md              Open a single markdown file in the editor',
    );
    expect(stdout).toContain(
      '  ok open ./start.md       Open a file whose name collides with a subcommand',
    );
  }, 30_000);

  test('Beta --help names open-knowledge-beta and ok-beta', () => {
    const result = runCliSource(['--help'], 'beta');
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Usage: open-knowledge-beta [options] [file | command]');
    expect(stdout).toContain(
      '  ok-beta notes.md              Open a single markdown file in the editor',
    );
    expect(stdout).not.toMatch(/^ {2}ok /m);
  }, 30_000);

  test('Beta `ui` tombstone points at ok-beta start', () => {
    const result = runCliSource(['ui'], 'beta');
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      '`ok-beta ui` was removed — the editor UI is served by the project server. Run `ok-beta start` instead.',
    );
  }, 30_000);
});

describe('CLI --version notice', () => {
  test('--version emits the version plus the GPL copyright / free-software / no-warranty trio', () => {
    const result = Bun.spawnSync({
      cmd: [
        'node',
        '--import',
        'tsx',
        '--conditions=development',
        '-e',
        `
        process.argv = [process.execPath, process.cwd() + '/src/cli.ts', '--version'];
        await import('./src/cli.ts');
        `,
      ],
      cwd: CLI_PACKAGE_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
    });

    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toMatch(/Copyright \(C\) \d{4} Inkeep, Inc\./);
    expect(stdout).toContain('GPL-3.0-or-later');
    expect(stdout).toMatch(/free software/i);
    expect(stdout).toMatch(/NO WARRANTY/);
  }, 30_000);
});

describe('the Windows process-start reader', () => {
  test('the CLI entry registers it for every command', () => {
    const result = Bun.spawnSync({
      cmd: [
        'node',
        '--import',
        'tsx',
        '--conditions=development',
        '-e',
        `
        process.on('exit', () => {
          const reader = globalThis[Symbol.for('@inkeep/open-knowledge/native-process-start-reader')];
          process.stdout.write('process-start-reader=' + typeof reader + '\\n');
        });
        process.argv = [process.execPath, process.cwd() + '/src/cli.ts', '--version'];
        await import('./src/cli.ts');
        `,
      ],
      cwd: CLI_PACKAGE_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('process-start-reader=function\n');
  }, 30_000);
});

describe('committed project-local key startup warning', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-committed-bind-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'server:\n  bind:\n    - 0.0.0.0\n');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('the preAction hook names a committed server.bind as ignored and points at the OK_BIND fix', () => {
    const result = Bun.spawnSync({
      cmd: [
        'node',
        '--import',
        'tsx',
        '--conditions=development',
        '-e',
        `
        process.argv = [
          process.execPath,
          process.cwd() + '/src/cli.ts',
          '--cwd',
          ${JSON.stringify(projectDir)},
          'ps',
          '--json',
        ];
        await import('./src/cli.ts');
        `,
      ],
      cwd: CLI_PACKAGE_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
    });

    const stderr = result.stderr.toString();
    expect(stderr).toContain('server.bind is a per-machine (project-local) setting');
    expect(stderr).toContain('.ok/local/config.yml');
    expect(stderr).toContain('OK_BIND');
    expect(stderr).not.toContain('ExposureConsentError');
  }, 30_000);
});
