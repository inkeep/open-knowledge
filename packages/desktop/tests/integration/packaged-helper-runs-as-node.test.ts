/**
 * Runtime guard for the detached-server helper binary in a packaged build.
 *
 * Bug class this test catches. The helper bundle at
 * `Contents/Frameworks/OpenKnowledge Server.app/Contents/MacOS/<exec>`
 * is populated by `scripts/afterPack.mjs` cloning the Electron Helper
 * Mach-O. Electron's helper stub inspects its own basename via
 * `_NSGetExecutablePath()` early in boot and silently SIGTRAPs (exit 133,
 * empty stderr) for any basename outside its hardcoded
 * `{generic, Renderer, GPU, Plugin}` type set. The original PR
 * shipped the cloned binary as `OpenKnowledge Server` — a descriptive
 * name that is NOT in Electron's set — so every detached-server spawn
 * died before `ELECTRON_RUN_AS_NODE=1` was consulted. Symptom in the
 * field: "OpenKnowledge server did not bind a port within 15000ms
 * after spawn (pid=N)" with no stderr tail (because the child crashed
 * before writing anything to its stderr fd).
 *
 * Existing structural tests (`helper-bundle-info-plist.test.ts`,
 * `helper-bundle-name-agreement.test.ts`, `dock-visibility.test.ts`)
 * are content-only and cannot detect this — they assert what's IN the
 * Info.plist / source files, not whether the cloned helper actually
 * BOOTS. This test fills that gap by exercising the real binary against
 * the production env vars (`ELECTRON_RUN_AS_NODE=1`) and asserting
 * non-trap exit + Node-mode stdout.
 *
 * Conditional execution. The two assertive tests below use
 * `test.skipIf(!havePackagedBuild)` so they report as skipped (not green)
 * when no packaged build exists under `dist-desktop/mac-<arch>/`.
 * A separate non-conditional gate test always runs and logs the gate
 * state so a CI / local run that lacks a packaged build is visible in
 * test output. Darwin-only (the helper bundle exists only on macOS
 * packaged builds — `resolveDetachedSpawnArgs` returns the parent
 * execPath off-darwin).
 *
 * Arch-glob for the dist subdir. electron-builder names its per-arch
 * output dir from the matrix arch (`dist-desktop/mac-arm64/`,
 * `dist-desktop/mac-x64/`, `dist-desktop/mac-universal/` after the
 * staged universal-binary flip). We
 * enumerate `mac-` prefixed children and pick the first whose
 * `OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Server.app/
 * Contents/MacOS/OpenKnowledge Helper` exists, so the test follows
 * the build output across the arch transition without a manual rename
 * here.
 *
 * To exercise locally:
 *   cd packages/desktop && bunx electron-builder --dir --publish never
 *   bun test tests/integration/packaged-helper-runs-as-node.test.ts
 *
 * Or via the okdesk function (see ~/.zshrc).
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HELPER_BUNDLE_NAME,
  HELPER_EXECUTABLE_NAME,
} from '@inkeep/open-knowledge-core/helper-bundle';

const HERE = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(HERE, '../..');
const distDesktopDir = resolve(desktopRoot, 'dist-desktop');

/**
 * Find the first `dist-desktop/mac-*` subdirectory that contains the
 * packaged helper binary at the expected path. Returns null if no such
 * subdir exists (no packaged build yet, or the build output moved to a
 * shape this test doesn't know about — in which case the conditional
 * tests below skip and the gate test logs the miss).
 */
function findPackagedHelperBinary(): string | null {
  if (!existsSync(distDesktopDir)) return null;
  let macSubdirs: readonly string[];
  try {
    macSubdirs = readdirSync(distDesktopDir).filter((name) => name.startsWith('mac-'));
  } catch {
    return null;
  }
  for (const subdir of macSubdirs) {
    const candidate = join(
      distDesktopDir,
      subdir,
      'OpenKnowledge.app',
      'Contents/Frameworks',
      HELPER_BUNDLE_NAME,
      'Contents/MacOS',
      HELPER_EXECUTABLE_NAME,
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const haveDarwin = process.platform === 'darwin';
const packagedHelperBinary = haveDarwin ? findPackagedHelperBinary() : null;
const havePackagedBuild = packagedHelperBinary !== null;

describe('packaged helper binary runs under ELECTRON_RUN_AS_NODE=1', () => {
  // Non-conditional gate test — logs the discovery state so a fresh
  // worktree or off-darwin CI run shows WHY the assertive tests below
  // skipped (`skipIf` alone surfaces "skipped" without a reason).
  test('test environment gate (packaged build present)', () => {
    if (!haveDarwin) {
      console.log(
        `[packaged-helper-runs-as-node] platform=${process.platform} — darwin-only test, skipping`,
      );
      return;
    }
    if (!havePackagedBuild) {
      console.log(
        `[packaged-helper-runs-as-node] no packaged helper binary found under ` +
          `${distDesktopDir}/mac-<arch>/OpenKnowledge.app/... — run ` +
          `\`bunx electron-builder --dir --publish never\` (or \`okdesk\`) to enable this test`,
      );
      return;
    }
    expect(existsSync(packagedHelperBinary as string)).toBe(true);
  });

  test.skipIf(!havePackagedBuild)(
    'helper binary exits 0 with stdout under ELECTRON_RUN_AS_NODE=1 (no SIGTRAP)',
    () => {
      // The smoking-gun assertion: spawn the cloned helper exactly the way
      // production does — with `ELECTRON_RUN_AS_NODE=1` and a Node script
      // arg — and confirm it runs as Node. The shipped binary
      // SIGTRAPs here with exit=133 and no stdout.
      //
      // The `as string` assertion is safe because `havePackagedBuild` already
      // narrowed `packagedHelperBinary` to non-null at module load; `skipIf`
      // is a runtime guard, not a TS narrowing site.
      const helperPath = packagedHelperBinary as string;
      const result = spawnSync(
        helperPath,
        ['-e', 'console.log("ok-helper-node-mode", process.versions.node)'],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );

      // The crash signature: SIGTRAP -> exit 133, empty stdout, empty stderr.
      // Failing this gate means the helper bundle is wired wrong (most likely
      // the executable basename — see resolve-detached-spawn-args.ts).
      expect({
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderrTail: result.stderr.slice(-200),
      }).toEqual({
        status: 0,
        signal: null,
        stdout: expect.stringMatching(/ok-helper-node-mode\s+\d+\.\d+\.\d+/),
        stderrTail: '',
      });
    },
  );

  test.skipIf(!havePackagedBuild)(
    'helper binary loads Electron Framework via @rpath without dyld errors',
    () => {
      // Smoke a separate failure class: dyld resolution. The cloned binary's
      // rpath is `@executable_path/../../..` (3 ups from the helper's MacOS
      // slot, landing on `Contents/Frameworks/` where Electron Framework
      // lives). A future refactor that nests the bundle one level deeper or
      // shallower silently breaks this; a renamed bundle that moves the
      // binary out of the 3-ups position would surface a dyld load error
      // here rather than a clean exit.
      const helperPath = packagedHelperBinary as string;
      const result = spawnSync(helperPath, ['-e', 'process.exit(0)'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(result.stderr).not.toContain('Library not loaded');
      expect(result.stderr).not.toContain('Unable to find helper app');
      expect(result.status).toBe(0);
    },
  );
});
