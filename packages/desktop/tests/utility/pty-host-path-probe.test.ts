import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveShellWithDetails } from '../../src/utility/pty-host.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

const execFileSyncMock = vi.mocked(execFileSync);

const WIN_ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
} as const;

function probeOptions(call = 0): { timeout?: number } | undefined {
  return execFileSyncMock.mock.calls[call]?.[2] as { timeout?: number } | undefined;
}

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe('defaultWindowsPathProbe (via resolveShellWithDetails, no pathProbe injected)', () => {
  test("matches the readiness probe's five-second timeout", () => {
    execFileSyncMock.mockReturnValue('C:\\tools\\pwsh.exe\r\n');

    resolveShellWithDetails(WIN_ENV, {
      platform: 'win32',
      shellExists: (path) => path === 'C:\\tools\\pwsh.exe',
    });

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const timeout = probeOptions()?.timeout;
    expect(timeout).toBe(5_000);
  });

  test('a timed-out probe falls through to the next rung instead of throwing', () => {
    const warnings: Record<string, unknown>[] = [];
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync where.exe ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        signal: 'SIGTERM',
      });
    });

    const resolution = resolveShellWithDetails(WIN_ENV, {
      platform: 'win32',
      shellExists: (path) => path === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      logger: { warn: (entry) => warnings.push(entry) },
    });

    expect(resolution.shell).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(resolution.rung).toBe('pwsh-known-install');
    expect(warnings).toContainEqual({
      event: 'pty-host-shell-path-probe-timed-out',
      command: 'pwsh',
      timeoutMs: 5_000,
    });
  });

  test('a non-timeout probe failure is logged before the ladder falls through', () => {
    const warnings: Record<string, unknown>[] = [];
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync where.exe EACCES'), { code: 'EACCES' });
    });

    const resolution = resolveShellWithDetails(WIN_ENV, {
      platform: 'win32',
      shellExists: (path) => path === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      logger: { warn: (entry) => warnings.push(entry) },
    });

    expect(resolution.rung).toBe('pwsh-known-install');
    expect(warnings).toContainEqual({
      event: 'pty-host-shell-path-probe-failed',
      command: 'pwsh',
      code: 'EACCES',
    });
  });

  test('still resolves the first absolute .exe line where.exe prints', () => {
    execFileSyncMock.mockReturnValue('pwsh\r\nC:\\tools\\pwsh.exe\r\nC:\\other\\pwsh.exe\r\n');

    const resolution = resolveShellWithDetails(WIN_ENV, {
      platform: 'win32',
      shellExists: (path) => path === 'C:\\tools\\pwsh.exe',
    });

    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe('C:\\Windows\\System32\\where.exe');
    expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual(['$PATH:pwsh']);
    expect(resolution.shell).toBe('C:\\tools\\pwsh.exe');
    expect(resolution.rung).toBe('pwsh-path');
  });
});

function fakeWhereExe(options: {
  files: readonly string[];
  cwd: string;
  pathEntries: readonly string[];
}) {
  return (_file: string, args: readonly string[]): string => {
    const pattern = args[0] ?? '';
    const pathScoped = pattern.startsWith('$PATH:');
    const name = pathScoped ? pattern.slice('$PATH:'.length) : pattern;
    const filename = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
    const searchDirs = pathScoped ? options.pathEntries : [options.cwd, ...options.pathEntries];
    const hits = searchDirs
      .map((dir) => win32.join(dir, filename))
      .filter((candidate) => options.files.includes(candidate));
    if (hits.length === 0) {
      throw Object.assign(new Error('INFO: Could not find files for the given pattern(s).'), {
        status: 1,
      });
    }
    return `${hits.join('\r\n')}\r\n`;
  };
}

const PROJECT_DIR = 'C:\\Users\\ok\\projects\\untrusted';
const KNOWN_INSTALL_PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

describe('the implicit pwsh probe is scoped to PATH', () => {
  test('a pwsh.exe in the working directory is not adopted as the shell', () => {
    const files = [win32.join(PROJECT_DIR, 'pwsh.exe'), KNOWN_INSTALL_PWSH];
    execFileSyncMock.mockImplementation(
      fakeWhereExe({ files, cwd: PROJECT_DIR, pathEntries: [] }) as never,
    );

    const resolution = resolveShellWithDetails(WIN_ENV, {
      platform: 'win32',
      shellExists: (path) => files.includes(path),
    });

    expect(resolution.shell).not.toBe(win32.join(PROJECT_DIR, 'pwsh.exe'));
    expect(resolution.shell).toBe(KNOWN_INSTALL_PWSH);
    expect(resolution.rung).toBe('pwsh-known-install');
  });

  test('an installed pwsh on PATH wins over a same-named file in the working directory', () => {
    const onPath = 'C:\\tools\\pwsh.exe';
    const files = [win32.join(PROJECT_DIR, 'pwsh.exe'), onPath];
    execFileSyncMock.mockImplementation(
      fakeWhereExe({ files, cwd: PROJECT_DIR, pathEntries: ['C:\\tools'] }) as never,
    );

    const resolution = resolveShellWithDetails(WIN_ENV, {
      platform: 'win32',
      shellExists: (path) => files.includes(path),
    });

    expect(resolution.shell).toBe(onPath);
    expect(resolution.rung).toBe('pwsh-path');
  });
});
