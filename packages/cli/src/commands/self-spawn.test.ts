import { afterEach, beforeEach, describe, expect, it, spyOn, test } from 'bun:test';
import {
  HELPER_BUNDLE_NAME,
  HELPER_EXECUTABLE_NAME,
  resolveHelperBundleBinary,
} from '@inkeep/open-knowledge-core/helper-bundle';
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
    // Guards the OLD-packaged-DMG-pre-helper case: shipping a CLI bump to a
    // user whose app pre-dates the helper bundle must NOT spawn ENOENT.
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
    // dev: bare node / bun
    '/usr/local/bin/node',
    '/opt/homebrew/bin/bun',
    // npm global install
    '/usr/local/lib/node_modules/@inkeep/open-knowledge/dist/cli.mjs',
    // Looks like an .app path but not at the MacOS slot
    '/Applications/OpenKnowledge.app/Contents/Resources/app/cli.mjs',
    // Substring `.app` but no `Contents/MacOS` slot
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
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Squelch + capture the fallback's console.warn so the test output stays
    // clean AND we can assert the warning fired (the warning is the only
    // operator-visible signal that we hit the rare fallback path).
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('re-execs the current binary when argv[1] is populated (production no-arg call)', () => {
    // Production path under normal node/bun/npx invocations — `argv[1]` is
    // always set. The helper returns (execPath, [entry]) so the sibling
    // process inherits the parent's exact version + runtime. No npx, and
    // (assuming the current process is not itself a packaged-Electron app
    // with a real helper bundle on disk) no Dock-tile redirect.
    const result = resolveSelfSpawn();
    const entry = process.argv[1];
    expect(entry).toBeDefined();
    expect(result.prefixArgs).toEqual([entry as string]);
    // CI (non-packaged Bun runtime): redirect doesn't fire → process.execPath.
    // If the runner itself is inside a packaged .app: redirect fires → helper
    // binary. Either is valid; a third value (e.g. npx) fails loudly.
    expect([process.execPath, resolveHelperBundleBinary(process.execPath)]).toContain(
      result.command,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to npx -y @inkeep/open-knowledge@latest when argv[1] is empty', () => {
    // The unreachable-in-practice fallback (exotic install shapes that
    // strip argv[1]). Pinning `@latest` here closes the silent-downgrade
    // half of the bug — without this test, a future revert to the bare
    // form (`['@inkeep/open-knowledge']`) would land green.
    const result = resolveSelfSpawn({ argv: ['runtime', ''] });
    expect(result.command).toBe('npx');
    expect(result.prefixArgs).toEqual(['-y', '@inkeep/open-knowledge@latest']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('packaged-darwin Electron execPath + helper present → command is the helper-bundle binary', () => {
    // Reproduces the bug-fix scenario: an `ok mcp` or `ok start` running
    // under the packaged macOS app would otherwise re-spawn the parent
    // `.app`'s main binary detached, leaking a stuck "exec" Dock tile per
    // auto-started server. The redirect points the sibling at the
    // `LSUIElement=true` helper bundle instead.
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
    // Graceful no-op for an older packaged DMG whose build pre-dates the
    // helper bundle. The CLI must NOT spawn ENOENT — the redirect predicate
    // gates on `exists()` exactly to avoid that regression class.
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
    // dev: bare node / bun
    '/usr/local/bin/node',
    '/opt/homebrew/bin/bun',
    // npm global install (CLI dist outside any .app bundle)
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
