import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const child = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => child);

import { runWindowsPackageTerminalSmoke } from './smoke-windows-terminal-package.mjs';

const fixtures = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test.each([0, 1])(
  'preserves the packaged observation files before cleanup when the driver exits %i',
  (status) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-pty-evidence-'));
    fixtures.push(root);
    const packageDir = join(root, 'package');
    const diagnosticsDir = join(root, 'evidence');
    const logDir = join(root, 'desktop-logs');
    mkdirSync(packageDir);
    mkdirSync(logDir);
    writeFileSync(join(packageDir, 'OpenKnowledge.exe'), 'fixture');
    let profile;
    child.spawn.mockImplementation((_file, args, options) => {
      profile = args
        .find((arg) => arg.startsWith('--user-data-dir='))
        .slice('--user-data-dir='.length);
      writeFileSync(join(profile, 'bug-report-main-thread-liveness.json'), '{"lastAck":1}');
      const record = {
        event: 'pty-phase',
        producer: 'main',
        pid: 12345,
        sequence: 1,
        atMs: 0,
        wallTimeMs: Date.now(),
        phase: 'paths',
        edge: 'point',
        userDataDir: profile,
        logDir,
      };
      writeFileSync(join(logDir, 'desktop.log'), `${JSON.stringify(record)}\n{"event":"boot"}\n`);
      writeSync(options.stdio[1], `${JSON.stringify(record)}\napp output\n`);
      return { pid: 12345 };
    });
    child.spawnSync.mockImplementation((file) =>
      file === 'taskkill'
        ? { status: 0 }
        : { status, stdout: 'driver output', stderr: status ? 'original echo failure' : '' },
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = () =>
      runWindowsPackageTerminalSmoke({
        packageDir,
        diagnosticsDir,
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      });
    if (status) expect(run).toThrow('packaged PTY CDP driver exited 1 (signal undefined)');
    else run();
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(diagnosticsDir), 'the uploaded evidence must survive fixture deletion').toBe(
      true,
    );
    const saved = join(diagnosticsDir, readdirSync(diagnosticsDir)[0]);
    expect(readFileSync(join(saved, 'app-stdio.log'), 'utf8')).toContain('app output');
    expect(readFileSync(join(saved, 'desktop-logs', 'desktop.log'), 'utf8')).toContain(
      '"event":"boot"',
    );
    expect(
      readFileSync(join(saved, 'user-data', 'bug-report-main-thread-liveness.json'), 'utf8'),
    ).toBe('{"lastAck":1}');
    expect(readFileSync(join(saved, 'driver.stdout.log'), 'utf8')).toBe('driver output');
    expect(readFileSync(join(saved, 'driver.stderr.log'), 'utf8')).toBe(
      status ? 'original echo failure' : '',
    );
    expect(JSON.parse(readFileSync(join(saved, 'manifest.json'), 'utf8')).driver.status).toBe(
      status,
    );
  },
);

test.each([0, 1])(
  'keeps the original driver outcome %i when evidence cannot be saved',
  (status) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-pty-evidence-error-'));
    fixtures.push(root);
    writeFileSync(join(root, 'OpenKnowledge.exe'), 'fixture');
    const diagnosticsDir = join(root, 'file-instead-of-directory');
    writeFileSync(diagnosticsDir, 'occupied');
    child.spawn.mockReturnValue({ pid: undefined });
    child.spawnSync.mockReturnValue({ status, signal: null, stdout: '', stderr: '' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = () =>
      runWindowsPackageTerminalSmoke({
        packageDir: root,
        diagnosticsDir,
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      });
    if (status) expect(run).toThrow('packaged PTY CDP driver exited 1 (signal null)');
    else expect(run).not.toThrow();
    expect(warning.mock.calls.flat().join('\n')).toContain(
      'Could not preserve packaged PTY diagnostics',
    );
    expect(readFileSync(diagnosticsDir, 'utf8')).toBe('occupied');
  },
);
