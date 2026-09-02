import {
  HELPER_BUNDLE_NAME,
  HELPER_EXECUTABLE_NAME,
  resolveHelperBundleBinary,
} from '@inkeep/open-knowledge-core/helper-bundle';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { maybeRedirectToHelperBundle, resolveSelfSpawn } from './self-spawn.ts';

const PACKAGED_APP = '/Applications/OpenKnowledge.app';
const PACKAGED_EXEC = `${PACKAGED_APP}/Contents/MacOS/OpenKnowledge`;
const PACKAGED_ENTRY = `${PACKAGED_APP}/Contents/Resources/app.asar.unpacked/dist/cli.mjs`;
const HELPER_BINARY = `${PACKAGED_APP}/Contents/Frameworks/${HELPER_BUNDLE_NAME}/Contents/MacOS/${HELPER_EXECUTABLE_NAME}`;

describe('maybeRedirectToHelperBundle', () => {
  const always = () => true;
  const never = () => false;

  test('darwin + packaged-Electron execPath + helper exists → returns helper path', () => {
    expect(
      maybeRedirectToHelperBundle({
        execPath: PACKAGED_EXEC,
        platform: 'darwin',
        exists: always,
      }),
    ).toBe(HELPER_BINARY);
  });

  test('darwin + packaged-Electron execPath + helper absent → null (graceful no-op)', () => {
    expect(
      maybeRedirectToHelperBundle({
        execPath: PACKAGED_EXEC,
        platform: 'darwin',
        exists: never,
      }),
    ).toBeNull();
  });

  test.each([
    ['linux', '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge'],
    ['win32', 'C:\\Program Files\\OpenKnowledge\\OpenKnowledge.exe'],
  ] as const)('non-darwin (%s) → null even if exists() would pass', (platform, execPath) => {
    expect(
      maybeRedirectToHelperBundle({
        execPath,
        platform,
        exists: always,
      }),
    ).toBeNull();
  });

  test.each([
    '/usr/local/bin/node',
    '/opt/homebrew/bin/bun',
    '/usr/local/lib/node_modules/@inkeep/open-knowledge/dist/cli.mjs',
    '/Applications/OpenKnowledge.app/Contents/Resources/app/cli.mjs',
    '/tmp/scratch.app.backup/cli',
  ])('darwin + non-bundle execPath (%s) → null', (execPath) => {
    expect(
      maybeRedirectToHelperBundle({
        execPath,
        platform: 'darwin',
        exists: always,
      }),
    ).toBeNull();
  });
});

describe('resolveSelfSpawn', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('re-execs the current binary when argv[1] is populated (production no-arg call)', () => {
    const result = resolveSelfSpawn();
    const entry = process.argv[1];
    expect(entry).toBeDefined();
    expect(result.prefixArgs).toEqual([entry as string]);
    expect([process.execPath, resolveHelperBundleBinary(process.execPath)]).toContain(
      result.command,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to npx -y @inkeep/open-knowledge@latest when argv[1] is empty', () => {
    const result = resolveSelfSpawn({ argv: ['runtime', ''] });
    expect(result.command).toBe('npx');
    expect(result.prefixArgs).toEqual(['-y', '@inkeep/open-knowledge@latest']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('packaged-darwin Electron execPath + helper present → command is the helper-bundle binary', () => {
    const result = resolveSelfSpawn({
      execPath: PACKAGED_EXEC,
      platform: 'darwin',
      argv: ['runtime', PACKAGED_ENTRY],
      exists: (p) => p === HELPER_BINARY,
    });
    expect(result.command).toBe(HELPER_BINARY);
    expect(result.prefixArgs).toEqual([PACKAGED_ENTRY]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('packaged-darwin Electron execPath + helper ABSENT → command stays process.execPath', () => {
    const result = resolveSelfSpawn({
      execPath: PACKAGED_EXEC,
      platform: 'darwin',
      argv: ['runtime', PACKAGED_ENTRY],
      exists: () => false,
    });
    expect(result.command).toBe(PACKAGED_EXEC);
    expect(result.prefixArgs).toEqual([PACKAGED_ENTRY]);
  });

  it.each([
    ['linux', PACKAGED_EXEC],
    ['win32', 'C:\\Program Files\\OpenKnowledge\\OpenKnowledge.exe'],
  ] as const)('non-darwin (%s) → command stays execPath (no LaunchServices)', (platform, execPath) => {
    const result = resolveSelfSpawn({
      execPath,
      platform,
      argv: ['runtime', '/entry/script'],
      exists: () => true,
    });
    expect(result.command).toBe(execPath);
    expect(result.prefixArgs).toEqual(['/entry/script']);
  });

  it.each([
    '/usr/local/bin/node',
    '/opt/homebrew/bin/bun',
    '/usr/local/lib/node_modules/@inkeep/open-knowledge/dist/cli.mjs',
  ])('darwin + non-bundle execPath (%s) → command stays execPath', (execPath) => {
    const result = resolveSelfSpawn({
      execPath,
      platform: 'darwin',
      argv: ['runtime', '/entry/script'],
      exists: () => true,
    });
    expect(result.command).toBe(execPath);
    expect(result.prefixArgs).toEqual(['/entry/script']);
  });
});
