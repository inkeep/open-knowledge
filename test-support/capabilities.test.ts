import { describe, expect, test } from 'vitest';
import { findExecutable, probePid1Reaps, probeRunningAsRoot } from './capabilities.test-helper.ts';

describe('environment capability probes', () => {
  test.each([
    { uid: 0, root: true },
    { uid: 501, root: false },
    { uid: undefined, root: false },
  ])('identifies uid $uid as root=$root', ({ uid, root }) => {
    expect(probeRunningAsRoot(uid)).toBe(root);
  });

  test.each(['lsof', 'uvx'] as const)('%s must be executable on PATH', (command) => {
    const executable = `/tools/${command}`;
    const input = {
      path: '/empty:/tools',
      platform: 'linux' as const,
      isExecutableFile: (path: string) => path === executable,
    };
    expect(findExecutable(command, input.path, input)).toBe(true);
    expect(findExecutable(command, '/empty', input)).toBe(false);
    expect(findExecutable(command, input.path, { ...input, isExecutableFile: () => false })).toBe(
      false,
    );
  });

  test('a POSIX empty PATH entry searches the current directory', () => {
    expect(
      findExecutable('uvx', '/empty:', {
        platform: 'darwin',
        isExecutableFile: (path) => path === 'uvx',
      }),
    ).toBe(true);
  });

  test('an unset POSIX PATH uses the process spawn default', () => {
    expect(
      findExecutable('lsof', undefined, {
        platform: 'linux',
        isExecutableFile: (path) => path === '/usr/bin/lsof',
      }),
    ).toBe(true);
  });

  test('Windows uvx uses the product PATHEXT search', () => {
    const input = {
      path: 'C:\\empty;C:\\tools',
      platform: 'win32' as const,
      pathExt: '.COM; .EXE; ;.CMD',
      isExecutableFile: (path: string) => path === 'C:\\tools\\uvx.EXE',
    };
    expect(findExecutable('uvx', input.path, input)).toBe(true);
    expect(findExecutable('uvx', 'C:\\empty', input)).toBe(false);
  });

  test.each(['systemd', 'init', 'tini', 'docker-init', 'dumb-init', 'catatonit'])(
    'PID 1 %s is a recognized reaper',
    (comm) => {
      expect(probePid1Reaps(`${comm}\n`)).toBe(true);
    },
  );

  test.each(['sleep', 'sleep\n'])('PID 1 %j is the observed non-reaper', (comm) => {
    expect(probePid1Reaps(comm)).toBe(false);
  });

  test.each(['bash', 'node', 'launchd', 'runner-init', 'sleepy', ''])(
    'PID 1 %j has not been observed to leave orphans unreaped',
    (comm) => {
      expect(probePid1Reaps(comm)).toBe(true);
    },
  );

  test('uses the supplied search path for an augmented uvx lookup', () => {
    const facts = {
      platform: 'darwin' as const,
      isExecutableFile: (path: string) => path === '/opt/homebrew/bin/uvx',
    };
    expect(findExecutable('uvx', '/empty', facts)).toBe(false);
    expect(findExecutable('uvx', '/empty:/opt/homebrew/bin', facts)).toBe(true);
  });

  test('an unreadable proc comm does not reject macOS or Windows', () => {
    expect(probePid1Reaps(undefined)).toBe(true);
  });
});
