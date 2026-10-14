import { describe, expect, test } from 'vitest';
import {
  type HostCliInvocation,
  mainProcessOkCli,
  type ResolveLocalOpCliInvocationInput,
  resolveLocalOpCliArgsForUtilityFork,
  resolveLocalOpCliInvocation,
} from './local-op-cli-invocation.ts';

const WIN_EXE =
  'C:\\Users\\q\\AppData\\Local\\Programs\\@inkeepopen-knowledge-desktop\\OpenKnowledge.exe';
const WIN_RESOURCES =
  'C:\\Users\\q\\AppData\\Local\\Programs\\@inkeepopen-knowledge-desktop\\resources';

const WORKSPACE_CLI = '/src/open-knowledge/packages/cli/dist/cli.mjs';

function invocationFor(
  input: Omit<ResolveLocalOpCliInvocationInput, 'workspaceCliBuilt'>,
): HostCliInvocation {
  const invocation = resolveLocalOpCliInvocation({ ...input, workspaceCliBuilt: true });
  if (invocation === undefined) throw new Error('expected a CLI invocation');
  return invocation;
}

const isWindowsBatchFile = (file: string): boolean => /\.(cmd|bat)$/i.test(file);

describe('resolveLocalOpCliInvocation', () => {
  test('an unpackaged build pinned to a shipped channel resolves the CLI from PATH with no env overlay', () => {
    expect(
      invocationFor({
        platform: 'win32',
        isPackaged: false,
        execPath: WIN_EXE,
        resourcesPath: WIN_RESOURCES,
        parentEnv: {},
        workspaceCliEntry: WORKSPACE_CLI,
      }),
    ).toEqual({ cliArgs: ['open-knowledge'] });
  });

  test('a dev-channel build runs the workspace CLI, which knows the dev channel, never the CLI on PATH', () => {
    const invocation = invocationFor({
      platform: 'darwin',
      isPackaged: false,
      execPath: '/src/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      resourcesPath: '/src/node_modules/electron/dist/Electron.app/Contents/Resources',
      parentEnv: { OK_CHANNEL: 'dev' },
      workspaceCliEntry: WORKSPACE_CLI,
    });
    expect(invocation).toEqual({ cliArgs: ['node', WORKSPACE_CLI] });
    expect(resolveLocalOpCliArgsForUtilityFork(invocation)).toEqual(['node', WORKSPACE_CLI]);
  });

  test('a dev-channel build with the workspace CLI unbuilt supplies no CLI, so the server never hands dev to the CLI on PATH', () => {
    expect(
      resolveLocalOpCliInvocation({
        platform: 'darwin',
        isPackaged: false,
        execPath: '/src/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        resourcesPath: '/src/node_modules/electron/dist/Electron.app/Contents/Resources',
        parentEnv: { OK_CHANNEL: 'dev' },
        workspaceCliEntry: WORKSPACE_CLI,
        workspaceCliBuilt: false,
      }),
    ).toBeUndefined();
  });

  test('packaged win32 spawns OpenKnowledge.exe as Node on the bundled CLI, never the .cmd wrapper', () => {
    const invocation = invocationFor({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: {},
      workspaceCliEntry: WORKSPACE_CLI,
    });
    expect(invocation.cliArgs).toEqual([WIN_EXE, `${WIN_RESOURCES}\\cli\\dist\\cli.mjs`]);
    expect(isWindowsBatchFile(invocation.cliArgs[0] ?? '')).toBe(false);
    expect(invocation.cliEnv).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
  });

  test('packaged win32 targets the keyring-resolvable cli/dist copy, not the app.asar.unpacked one', () => {
    const invocation = invocationFor({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: {},
      workspaceCliEntry: WORKSPACE_CLI,
    });
    const entry = invocation.cliArgs[1] ?? '';
    expect(entry).toBe(`${WIN_RESOURCES}\\cli\\dist\\cli.mjs`);
    expect(entry).not.toContain('app.asar.unpacked');
  });

  test('packaged win32 moves NODE_OPTIONS aside the way ok.cmd does', () => {
    const invocation = invocationFor({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: { NODE_OPTIONS: '--require ./hook.js' },
      workspaceCliEntry: WORKSPACE_CLI,
    });
    expect(invocation.cliEnv).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: undefined,
      OK_NODE_OPTIONS: '--require ./hook.js',
    });
    expect(Object.hasOwn(invocation.cliEnv ?? {}, 'NODE_OPTIONS')).toBe(true);
  });

  test('packaged win32 without NODE_OPTIONS still clears it and sets no OK_NODE_OPTIONS', () => {
    const invocation = invocationFor({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: { PATH: 'C:\\Windows' },
      workspaceCliEntry: WORKSPACE_CLI,
    });
    expect(invocation.cliEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined });
  });

  test('packaged darwin and linux keep the executable shell wrapper', () => {
    expect(
      invocationFor({
        platform: 'darwin',
        isPackaged: true,
        execPath: '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        resourcesPath: '/Applications/OpenKnowledge.app/Contents/Resources',
        parentEnv: {},
        workspaceCliEntry: WORKSPACE_CLI,
      }),
    ).toEqual({ cliArgs: ['/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh'] });
    expect(
      invocationFor({
        platform: 'linux',
        isPackaged: true,
        execPath: '/opt/OpenKnowledge/openknowledge',
        resourcesPath: '/opt/OpenKnowledge/resources',
        parentEnv: {},
        workspaceCliEntry: WORKSPACE_CLI,
      }),
    ).toEqual({ cliArgs: ['/opt/OpenKnowledge/resources/cli/bin/ok.sh'] });
  });
});

describe('resolveLocalOpCliArgsForUtilityFork', () => {
  test('returns a detached copy of cliArgs when the invocation carries no env overlay', () => {
    const invocation = invocationFor({
      platform: 'win32',
      isPackaged: false,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: {},
      workspaceCliEntry: WORKSPACE_CLI,
    });
    const args = resolveLocalOpCliArgsForUtilityFork(invocation);
    expect(args).toEqual(['open-knowledge']);
    expect(args).not.toBe(invocation.cliArgs);
  });

  test('returns the darwin wrapper path, which is runnable without an env overlay', () => {
    expect(
      resolveLocalOpCliArgsForUtilityFork(
        invocationFor({
          platform: 'darwin',
          isPackaged: true,
          execPath: '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
          resourcesPath: '/Applications/OpenKnowledge.app/Contents/Resources',
          parentEnv: {},
          workspaceCliEntry: WORKSPACE_CLI,
        }),
      ),
    ).toEqual(['/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh']);
  });

  test('throws on a packaged win32 invocation rather than silently dropping its cliEnv', () => {
    const invocation = invocationFor({
      platform: 'win32',
      isPackaged: true,
      execPath: WIN_EXE,
      resourcesPath: WIN_RESOURCES,
      parentEnv: {},
      workspaceCliEntry: WORKSPACE_CLI,
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

describe('mainProcessOkCli', () => {
  test('a dev build pins dev on its workspace CLI, since the spawn drops the inherited channel', () => {
    const cli = mainProcessOkCli({ cliArgs: ['node', WORKSPACE_CLI] }, { OK_CHANNEL: 'dev' });
    expect(cli.runnerInvocation(['auth', 'login'])).toEqual({
      cliArgs: ['node', WORKSPACE_CLI, 'auth', 'login'],
      cliEnv: { OK_CHANNEL: 'dev' },
    });
  });

  test('a dev build with no workspace CLI reads through the CLI on PATH with no channel and refuses sign-in', () => {
    const cli = mainProcessOkCli(undefined, { OK_CHANNEL: 'dev' });
    expect(cli.runnerInvocation(['auth', 'status'])).toEqual({
      cliArgs: ['open-knowledge', 'auth', 'status'],
      cliEnv: {},
    });
    expect(cli.refusalFor(['auth', 'login'])).toContain('pnpm build');
  });

  test('keeps the packaged win32 overlay alongside the channel pin', () => {
    expect(
      mainProcessOkCli(
        { cliArgs: [WIN_EXE, 'cli.mjs'], cliEnv: { ELECTRON_RUN_AS_NODE: '1' } },
        { OK_CHANNEL: 'beta' },
      ).runnerInvocation([]),
    ).toEqual({
      cliArgs: [WIN_EXE, 'cli.mjs'],
      cliEnv: { ELECTRON_RUN_AS_NODE: '1', OK_CHANNEL: 'beta' },
    });
  });
});
