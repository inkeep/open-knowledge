import { describe, expect, test } from 'vitest';
import {
  type ResolveDetachedSpawnArgsInput,
  resolveDetachedSpawnArgs,
} from './resolve-detached-spawn-args.ts';

const PARENT_APP = '/Applications/OpenKnowledge.app';
const PARENT_EXEC = `${PARENT_APP}/Contents/MacOS/OpenKnowledge`;
const HELPER_BINARY = `${PARENT_APP}/Contents/Frameworks/OpenKnowledge Server.app/Contents/MacOS/OpenKnowledge Helper`;

function makeInput(
  overrides: Partial<ResolveDetachedSpawnArgsInput> = {},
): ResolveDetachedSpawnArgsInput {
  return {
    platform: 'darwin',
    isPackaged: true,
    parentExecPath: PARENT_EXEC,
    bundleCliMjsPath: `${PARENT_APP}/Contents/Resources/app.asar.unpacked/dist/cli.mjs`,
    reactShellDistDir: `${PARENT_APP}/Contents/Resources/app`,
    contentDir: '/tmp/some-project',
    spawnErrorLogFd: 5,
    env: { PATH: '/usr/bin' },
    ...overrides,
  };
}

describe('resolveDetachedSpawnArgs', () => {
  test('darwin packaged → file targets the helper bundle MacOS binary, not the parent execPath', () => {
    const { file } = resolveDetachedSpawnArgs(makeInput());
    expect(file).toBe(HELPER_BINARY);
    expect(file).not.toBe(PARENT_EXEC);
  });

  test.each([
    ['darwin', false],
    ['linux', true],
    ['linux', false],
    ['win32', true],
    ['win32', false],
  ] as const)('platform=%s packaged=%s → file is the parent execPath', (platform, isPackaged) => {
    const { file } = resolveDetachedSpawnArgs(makeInput({ platform, isPackaged }));
    expect(file).toBe(PARENT_EXEC);
  });

  test('opts.env injects ELECTRON_RUN_AS_NODE=1 and OK_LOCK_KIND=interactive and preserves the inherited env', () => {
    const { opts } = resolveDetachedSpawnArgs(makeInput({ env: { PATH: '/usr/bin', FOO: 'bar' } }));
    expect(opts.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(opts.env?.OK_LOCK_KIND).toBe('interactive');
    expect(opts.env?.PATH?.split(':')).toContain('/usr/bin');
    expect(opts.env?.FOO).toBe('bar');
  });

  test('darwin → opts.env.PATH prepends macOS git fallback dirs and preserves inherited PATH', () => {
    const { opts } = resolveDetachedSpawnArgs(
      makeInput({ platform: 'darwin', env: { PATH: '/usr/bin:/opt/dev/bin' } }),
    );
    const segments = (opts.env?.PATH ?? '').split(':');
    expect(segments[0]).toBe('/opt/homebrew/bin');
    expect(segments).toContain('/usr/local/bin');
    expect(segments).toContain('/Library/Developer/CommandLineTools/usr/bin');
    expect(segments).toContain('/usr/bin');
    expect(segments).toContain('/opt/dev/bin');
  });

  test('linux → opts.env.PATH prepends Linux git fallback dirs and preserves inherited PATH', () => {
    const { opts } = resolveDetachedSpawnArgs(
      makeInput({ platform: 'linux', env: { PATH: '/opt/myapp/bin' } }),
    );
    const segments = (opts.env?.PATH ?? '').split(':');
    expect(segments[0]).toBe('/usr/bin');
    expect(segments).toContain('/usr/local/bin');
    expect(segments).toContain('/snap/bin');
    expect(segments).toContain('/opt/myapp/bin');
  });

  test('win32 → opts.env.PATH prepends Windows git fallback dirs with `;` delimiter', () => {
    const { opts } = resolveDetachedSpawnArgs(
      makeInput({
        platform: 'win32',
        env: { PATH: 'C:\\Windows;C:\\Windows\\System32' },
      }),
    );
    const segments = (opts.env?.PATH ?? '').split(';');
    expect(segments[0]).toBe('C:\\Program Files\\Git\\cmd');
    expect(segments).toContain('C:\\Program Files (x86)\\Git\\cmd');
    expect(segments).toContain('C:\\Windows');
    expect(segments).toContain('C:\\Windows\\System32');
  });

  test('win32 → inherited PATH is read case-insensitively (`Path` key) so System32 survives', () => {
    const { opts } = resolveDetachedSpawnArgs(
      makeInput({
        platform: 'win32',
        env: { Path: 'C:\\Windows;C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
      }),
    );
    const segments = (opts.env?.PATH ?? '').split(';');
    expect(segments).toContain('C:\\Windows\\System32');
    expect(segments).toContain('C:\\Windows');
    expect(segments[0]).toBe('C:\\Program Files\\Git\\cmd');
  });

  test('win32 → emits exactly one canonical PATH key (no `Path`/`PATH` collision)', () => {
    const { opts } = resolveDetachedSpawnArgs(
      makeInput({ platform: 'win32', env: { Path: 'C:\\Windows\\System32', FOO: 'bar' } }),
    );
    const pathKeys = Object.keys(opts.env ?? {}).filter((k) => /^path$/i.test(k));
    expect(pathKeys).toEqual(['PATH']);
    expect(opts.env?.PATH?.split(';')).toContain('C:\\Windows\\System32');
    expect(opts.env?.FOO).toBe('bar');
  });

  test('enriched PATH deduplicates dirs already present in inherited PATH', () => {
    const { opts } = resolveDetachedSpawnArgs(
      makeInput({
        platform: 'linux',
        env: { PATH: '/usr/bin:/snap/bin:/opt/foo' },
      }),
    );
    const segments = (opts.env?.PATH ?? '').split(':');
    expect(segments.filter((s) => s === '/usr/bin')).toHaveLength(1);
    expect(segments.filter((s) => s === '/snap/bin')).toHaveLength(1);
    expect(segments[0]).toBe('/usr/bin');
    expect(segments).toContain('/opt/foo');
  });

  test('enrichment still happens when inherited env has no PATH', () => {
    const { opts } = resolveDetachedSpawnArgs(
      makeInput({ platform: 'linux', env: { FOO: 'bar' } }),
    );
    const pathValue = opts.env?.PATH ?? '';
    expect(pathValue).toBeTruthy();
    const segments = pathValue.split(':');
    expect(segments).toContain('/usr/bin');
    expect(segments).toContain('/snap/bin');
  });

  test('enriched PATH wins over a PATH value coming in via env (no shadow)', () => {
    const { opts } = resolveDetachedSpawnArgs(
      makeInput({ platform: 'darwin', env: { PATH: '/some/inherited/path' } }),
    );
    const pathValue = opts.env?.PATH ?? '';
    expect(pathValue.startsWith('/opt/homebrew/bin')).toBe(true);
    expect(pathValue).toContain('/some/inherited/path');
  });

  test('opts wire the detached lifecycle, stderr-only stdio, and content-dir cwd', () => {
    const { opts } = resolveDetachedSpawnArgs(makeInput({ spawnErrorLogFd: 9 }));
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(['ignore', 'ignore', 9]);
    expect(opts.cwd).toBe('/tmp/some-project');
  });

  test('args invoke the bundled CLI with start + the react shell dist dir', () => {
    const { args } = resolveDetachedSpawnArgs(makeInput());
    expect(args).toEqual([
      '--max-old-space-size=16384',
      `${PARENT_APP}/Contents/Resources/app.asar.unpacked/dist/cli.mjs`,
      'start',
      '--react-shell-dist-dir',
      `${PARENT_APP}/Contents/Resources/app`,
    ]);
    expect(args).not.toContain('--serve-content-assets');
  });

  test('ephemeral mode appends --single-file + --project-dir and cwds at the temp project root', () => {
    const { args, opts } = resolveDetachedSpawnArgs(
      makeInput({
        contentDir: '/Users/me/notes',
        projectDir: '/tmp/ok-ephemeral-xyz',
        singleFile: '/Users/me/notes/todo.md',
      }),
    );
    expect(args).toEqual([
      '--max-old-space-size=16384',
      `${PARENT_APP}/Contents/Resources/app.asar.unpacked/dist/cli.mjs`,
      'start',
      '--react-shell-dist-dir',
      `${PARENT_APP}/Contents/Resources/app`,
      '--single-file',
      '/Users/me/notes/todo.md',
      '--project-dir',
      '/tmp/ok-ephemeral-xyz',
    ]);
    expect(opts.cwd).toBe('/tmp/ok-ephemeral-xyz');
  });

  test('non-ephemeral spawn carries no single-file flags (absent fields omit cleanly)', () => {
    const { args } = resolveDetachedSpawnArgs(makeInput());
    expect(args).not.toContain('--single-file');
    expect(args).not.toContain('--project-dir');
  });
});
