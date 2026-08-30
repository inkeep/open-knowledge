import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  runWindowsPackageTerminalSmoke,
  seedWindowsPtySmokeProject,
  windowsPackageLaunchArgs,
  windowsPtyDriverEnv,
} from './smoke-windows-terminal-package.mjs';

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('packaged Windows terminal smoke driver', () => {
  test('seeds deterministic project-local terminal config for the packaged app', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-win-pty-smoke-test-'));
    fixtures.push(root);
    const { projectDir, userDataDir } = seedWindowsPtySmokeProject(
      root,
      'C:\\Windows\\System32\\cmd.exe',
    );

    expect(readFileSync(join(projectDir, '.ok', 'config.yml'), 'utf8')).toBe(
      "content:\n  dir: '.'\n",
    );
    expect(readFileSync(join(projectDir, '.ok', 'local', 'config.yml'), 'utf8')).toBe(
      'terminal:\n  enabled: true\n  shell: "C:\\\\Windows\\\\System32\\\\cmd.exe"\n',
    );
    expect(readFileSync(join(projectDir, 'start.md'), 'utf8')).toContain('Windows terminal');
    expect(userDataDir).toBe(join(root, 'user-data'));
  });

  test('fails closed on missing ComSpec before touching a package', () => {
    expect(() => runWindowsPackageTerminalSmoke({ platform: 'win32', env: {} })).toThrow(
      /requires ComSpec in its environment/,
    );
  });

  test('launches a unique project through a loopback-only CDP endpoint', () => {
    const args = windowsPackageLaunchArgs('C:\\Temp\\Project With Spaces', 'C:\\Temp\\User Data');

    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--user-data-dir=C:\\Temp\\User Data');
    expect(args.at(-1)).toBe(
      'openknowledge://open?project=C%3A%5CTemp%5CProject%20With%20Spaces&doc=start',
    );
  });

  test('fails closed when invoked anywhere except a real Windows runner', () => {
    expect(() => runWindowsPackageTerminalSmoke({ platform: 'linux' })).toThrow(
      /must run on Windows/,
    );
  });

  test('requires the CDP driver to exercise its Windows branch', () => {
    expect(windowsPtyDriverEnv({ SENTINEL: 'preserved' })).toEqual({
      SENTINEL: 'preserved',
      OK_SMOKE_EXPECT_PLATFORM: 'win32',
    });
  });
});
