import { describe, expect, test } from 'vitest';
import {
  resolveLocalOpCliArgsForUtilityFork,
  resolveLocalOpCliInvocation,
} from './local-op-cli-invocation.ts';

const WIN_EXE =
  'C:\\Users\\q\\AppData\\Local\\Programs\\@inkeepopen-knowledge-desktop\\OpenKnowledge.exe';
const WIN_RESOURCES =
  'C:\\Users\\q\\AppData\\Local\\Programs\\@inkeepopen-knowledge-desktop\\resources';

const isWindowsBatchFile = (file: string): boolean => /\.(cmd|bat)$/i.test(file);

describe('resolveLocalOpCliInvocation', () => {
  test('dev builds resolve the CLI from PATH with no env overlay', () => {
    expect(
      resolveLocalOpCliInvocation({
        platform: 'win32',
        isPackaged: false,
        execPath: WIN_EXE,
        resourcesPath: WIN_RESOURCES,
        parentEnv: {},
      }),
    ).toEqual({ cliArgs: ['open-knowledge'] });
  });

  test('packaged win32 spawns OpenKnowledge.exe as Node on the bundled CLI, never the .cmd wrapper', () => {
    const invocation = resolveLocalOpCliInvocation({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: {},
    });
    expect(invocation.cliArgs).toEqual([WIN_EXE, `${WIN_RESOURCES}\\cli\\dist\\cli.mjs`]);
    expect(isWindowsBatchFile(invocation.cliArgs[0] ?? '')).toBe(false);
    expect(invocation.cliEnv).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
  });

  test('packaged win32 targets the keyring-resolvable cli/dist copy, not the app.asar.unpacked one', () => {
    const invocation = resolveLocalOpCliInvocation({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: {},
    });
    const entry = invocation.cliArgs[1] ?? '';
    expect(entry).toBe(`${WIN_RESOURCES}\\cli\\dist\\cli.mjs`);
    expect(entry).not.toContain('app.asar.unpacked');
  });

  test('packaged win32 moves NODE_OPTIONS aside the way ok.cmd does', () => {
    const invocation = resolveLocalOpCliInvocation({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: { NODE_OPTIONS: '--require ./hook.js' },
    });
    expect(invocation.cliEnv).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: undefined,
      OK_NODE_OPTIONS: '--require ./hook.js',
    });
    expect(Object.hasOwn(invocation.cliEnv ?? {}, 'NODE_OPTIONS')).toBe(true);
  });

  test('packaged win32 without NODE_OPTIONS still clears it and sets no OK_NODE_OPTIONS', () => {
    const invocation = resolveLocalOpCliInvocation({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: { PATH: 'C:\\Windows' },
    });
    expect(invocation.cliEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined });
  });

  test('packaged darwin and linux keep the executable shell wrapper', () => {
    expect(
      resolveLocalOpCliInvocation({
        platform: 'darwin',
        isPackaged: true,
        execPath: '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        resourcesPath: '/Applications/OpenKnowledge.app/Contents/Resources',
        parentEnv: {},
      }),
    ).toEqual({ cliArgs: ['/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh'] });
    expect(
      resolveLocalOpCliInvocation({
        platform: 'linux',
        isPackaged: true,
        execPath: '/opt/OpenKnowledge/openknowledge',
        resourcesPath: '/opt/OpenKnowledge/resources',
        parentEnv: {},
      }),
    ).toEqual({ cliArgs: ['/opt/OpenKnowledge/resources/cli/bin/ok.sh'] });
  });
});

describe('resolveLocalOpCliArgsForUtilityFork', () => {
  test('returns a detached copy of cliArgs when the invocation carries no env overlay', () => {
    const invocation = resolveLocalOpCliInvocation({
      platform: 'win32',
      isPackaged: false,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: {},
    });
    const args = resolveLocalOpCliArgsForUtilityFork(invocation);
    expect(args).toEqual(['open-knowledge']);
    expect(args).not.toBe(invocation.cliArgs);
  });

  test('returns the darwin wrapper path, which is runnable without an env overlay', () => {
    expect(
      resolveLocalOpCliArgsForUtilityFork(
        resolveLocalOpCliInvocation({
          platform: 'darwin',
          isPackaged: true,
          execPath: '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
          resourcesPath: '/Applications/OpenKnowledge.app/Contents/Resources',
          parentEnv: {},
        }),
      ),
    ).toEqual(['/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh']);
  });

  test('throws on a packaged win32 invocation rather than silently dropping its cliEnv', () => {
    const invocation = resolveLocalOpCliInvocation({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: {},
    });
    expect(invocation.cliEnv).toBeDefined();
    expect(() => resolveLocalOpCliArgsForUtilityFork(invocation)).toThrow(/cliEnv/);
  });

  test('throws for any invocation carrying a cliEnv overlay, not just the win32 shape', () => {
    expect(() =>
      resolveLocalOpCliArgsForUtilityFork({
        cliArgs: ['open-knowledge'],
        cliEnv: { ELECTRON_RUN_AS_NODE: '1' },
      }),
    ).toThrow(/cliEnv/);
  });
});
