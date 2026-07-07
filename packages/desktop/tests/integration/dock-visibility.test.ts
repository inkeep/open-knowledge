/**
 * Regression guard: the desktop's detached-server spawn at
 * `packages/desktop/src/main/index.ts` (`spawnDetachedServer` callback)
 * MUST NOT cause macOS LaunchServices to register a duplicate Dock tile for
 * the parent `.app` bundle.
 *
 * Symptom (per the field report). On a packaged launch the parent
 * OpenKnowledge Dock icon is joined by a second tile labeled "exec" with
 * the macOS launching-bobble animation that never resolves. The tile
 * persists for the lifetime of the spawned server child.
 *
 * Mechanism. `process.execPath` inside a packaged Electron app on macOS is
 * `<.app>/Contents/MacOS/<MainBinary>` — the parent's own foreground GUI
 * binary. Calling `child_process.spawn(process.execPath, ..., { detached: true })`
 * is treated by `coreservicesd`/LaunchServices as the start of a duplicate
 * `.app` launch; the spawned child enters a launching-handshake state that
 * never completes because `ELECTRON_RUN_AS_NODE=1` short-circuits the
 * NSApplication bootstrap. The Dock tile sticks in the placeholder state.
 *
 * Two structural mechanisms cure the bug; the test below is fix-agnostic
 * and either passes:
 *
 *   (a) The spawn file argument is NOT inside the parent `.app/Contents/MacOS/`
 *       directory — either a bundled non-`.app` Node host, or the MacOS
 *       binary of a SEPARATE helper `.app` (e.g.
 *       `<parent .app>/Contents/Frameworks/<Helper>.app/Contents/MacOS/...`
 *       whose Info.plist declares `LSUIElement=true`). See
 *       `resolve-detached-spawn-args.ts`.
 *   (b) The spawn opts include an `argv0` override pointing outside any
 *       `.app/Contents/MacOS/` directory so the parent's bundle association
 *       is not propagated to LaunchServices. A third option that's just
 *       `argv0` without (a) was considered and rejected as
 *       structurally suspect (LaunchServices keys on the binary path, not
 *       argv0) — it's listed under (b) only because the test invariant
 *       is permissive enough to accept it if the producer ever proves it
 *       works in practice.
 *
 * These tests cannot directly observe the Dock — that requires a Playwright-
 * driven packaged Electron build, see `tests/integration/detached-lifecycle.test.ts`
 * for why the existing integration test exercises the spawn shape against
 * the `bun` binary (where `process.execPath` is not a `.app` MacOS binary and
 * the LaunchServices side-effect cannot manifest). What this file pins is
 * the structural producer-side invariant: if upheld, the user-visible
 * symptom is unreachable on darwin packaged builds.
 *
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDetachedSpawnArgs } from '../../src/main/resolve-detached-spawn-args.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(HERE, '../..');
const indexTsPath = resolve(desktopRoot, 'src/main/index.ts');

/**
 * Walk path segments from the leaf inwards and return the path of the
 * INNERMOST `.app` ancestor whose `Contents/MacOS/` directly contains the
 * binary, or null if the binary is not inside any `.app/Contents/MacOS/`.
 *
 * Distinguishes a parent-bundle re-exec (binary at
 * `/Applications/Foo.app/Contents/MacOS/Foo`) from a helper-bundle re-exec
 * (binary at `/Applications/Foo.app/Contents/Frameworks/Helper.app/Contents/
 * MacOS/Helper`) — the helper's innermost `.app` is itself, not the parent.
 */
function innermostAppContainer(pathLike: string): string | null {
  const segments = pathLike.split('/');
  for (let i = segments.length - 1; i >= 0; i--) {
    if (
      segments[i]?.endsWith('.app') &&
      segments[i + 1] === 'Contents' &&
      segments[i + 2] === 'MacOS'
    ) {
      return segments.slice(0, i + 1).join('/');
    }
  }
  return null;
}

describe('detached-server spawn: macOS Dock visibility regression guard', () => {
  // Two tests, each pinning a different surface:
  //
  //   • The bypass-pin (below) catches re-inlining the spawn call back into
  //     index.ts as `spawn(process.execPath, ...)` — a regression that would
  //     NOT be caught by the runtime-pin because it sidesteps the resolver
  //     entirely. Implemented as a tight grep, not a structural parse — when
  //     the spawn site refactors further, the grep stays valid as long as
  //     nobody writes `spawn(process.execPath, ...)` anywhere in index.ts.
  //
  //   • The runtime-pin imports the resolver and exercises it directly. It
  //     pins the structural shape returned by `resolveDetachedSpawnArgs` on
  //     darwin packaged inputs.
  test('bypass-pin — index.ts must not call spawn(process.execPath, ...) directly', () => {
    // Catches the specific regression of someone re-inlining the spawn call
    // (sidestepping the extracted resolver). The runtime-pin below would
    // pass under that bypass because the resolver still works correctly when
    // tested in isolation — but the spawn site would no longer use it.
    //
    // Looser than the prior source-pin (which regex-parsed the callback body
    // and matched the file argument): a single grep across the file, fail-
    // closed if the literal pattern reappears. Cheap to maintain.
    const src = readFileSync(indexTsPath, 'utf-8');
    const bypass = /spawn\s*\(\s*process\.execPath\s*[,)]/;
    const match = bypass.exec(src);
    expect(
      match,
      `\n[dock-visibility] index.ts contains a direct \`spawn(process.execPath, ...)\` ` +
        `call.\n\n` +
        `That is exactly the regression this PR fixed: on packaged macOS, process.execPath ` +
        `is the parent .app's MacOS binary, and spawning it (even under ELECTRON_RUN_AS_NODE=1) ` +
        `triggers LaunchServices to register a duplicate Dock tile (the "exec" placeholder).\n\n` +
        `Route the spawn through resolveDetachedSpawnArgs() — see\n` +
        `  packages/desktop/src/main/resolve-detached-spawn-args.ts\n` +
        `which returns a structurally safe file argument on darwin packaged. The runtime-pin ` +
        `test below covers the resolver's behavior; this bypass-pin covers the spawn site itself.\n\n` +
        `If you intentionally need to spawn the parent binary directly (e.g. for non-detached ` +
        `cases not subject to LaunchServices), document the reason inline and update this test ` +
        `to scope the bypass-pin to the spawnDetachedServer callback specifically.\n`,
    ).toBeNull();
  });

  test('runtime pin — resolveDetachedSpawnArgs() returns a structurally safe shape on darwin packaged', () => {
    // Imports the production resolver and exercises it with simulated
    // darwin-packaged inputs. If the resolver moves, the static import at the
    // top of this file fails at compile time — a clearer signal.

    // Simulate the packaged-darwin context that produces the bug.
    const parentAppPath = '/Applications/OpenKnowledge.app';
    const parentExecPath = `${parentAppPath}/Contents/MacOS/OpenKnowledge`;
    const bundleCliMjsPath = `${parentAppPath}/Contents/Resources/app.asar.unpacked/node_modules/@inkeep/open-knowledge/dist/cli.mjs`;
    const reactShellDistDir = `${parentAppPath}/Contents/Resources/app`;

    const result = resolveDetachedSpawnArgs({
      platform: 'darwin',
      isPackaged: true,
      parentExecPath,
      bundleCliMjsPath,
      reactShellDistDir,
      contentDir: '/tmp/some-project',
      spawnErrorLogFd: 5,
      env: { PATH: '/usr/bin' },
    });

    // The file argument's innermost containing .app — null means the path
    // is outside any .app/Contents/MacOS/.
    const fileApp = innermostAppContainer(result.file);
    const fileTriggersParentAppLaunch = fileApp === parentAppPath;

    // argv0 override (if present) must also not point at the parent .app's
    // MacOS dir, otherwise it doesn't suppress the LaunchServices launch.
    const argv0 = (result.opts as { argv0?: string }).argv0;
    const argv0HasSafeOverride =
      typeof argv0 === 'string' && innermostAppContainer(argv0) !== parentAppPath;

    const ok = !fileTriggersParentAppLaunch || argv0HasSafeOverride;

    expect(
      ok,
      `\n[dock-visibility] resolveDetachedSpawnArgs returned a spawn shape that triggers\n` +
        `LaunchServices on darwin packaged builds:\n` +
        `  file:        ${result.file}\n` +
        `  opts.argv0:  ${argv0 ?? '(unset)'}\n` +
        `  innermost .app of file:   ${fileApp ?? '(none — file is outside any .app)'}\n` +
        `  innermost .app of argv0:  ${typeof argv0 === 'string' ? innermostAppContainer(argv0) : '(no argv0)'}\n\n` +
        `Either the file MUST resolve to a binary outside ${parentAppPath}/Contents/MacOS/\n` +
        `(non-.app Node host or a separate helper .app bundle), or opts.argv0 MUST override\n` +
        `to a path outside the parent .app's MacOS directory.\n`,
    ).toBe(true);
  });
});
