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
    // Spawns a fresh `bun` that cold-imports the whole CLI and runs `ps --json`;
    // the default 5s test timeout is too tight for that under local machine load.
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
      env: { ...process.env, NO_COLOR: '1' },
    });

    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain('`ok ui` was removed');
    expect(stderr).toContain('ok start');
    expect(stderr).not.toContain('too many arguments');
  }, 30_000);
});

describe('CLI --version notice', () => {
  test('--version emits the version plus the GPL copyright / free-software / no-warranty trio', () => {
    // Exercises the wired surface — `.version(buildVersionNotice(...))` in cli.ts
    // through Commander's `--version` handler — not just the pure builder. A
    // regression that reverted the version action to the bare version string
    // would pass version-notice.test.ts but fail here.
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

describe('committed project-local key startup warning', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-committed-bind-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    // A committed non-loopback bind — the clone-breaking case. It resolves to
    // the loopback default (ignored), and the preAction hook must name it.
    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'server:\n  bind:\n    - 0.0.0.0\n');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('the preAction hook names a committed server.bind as ignored and points at the OK_BIND fix', () => {
    // Exercises the wired emission loop in cli.ts — the loader-level and
    // formatter-level unit tests both pass even if this glue is removed, so a
    // command that goes through the preAction hook (`ok ps`) is the surface that
    // proves the startup warning actually reaches stderr.
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
    // The committed value is IGNORED, not applied — nothing exposes, so the
    // exposure interlock must never fire on this read-only listing.
    expect(stderr).not.toContain('ExposureConsentError');
  }, 30_000);
});
