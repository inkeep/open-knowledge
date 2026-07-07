import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HELPER_BUNDLE_NAME,
  HELPER_EXECUTABLE_NAME,
} from '@inkeep/open-knowledge-core/helper-bundle';

/**
 * Cross-reference regression guard: the FIVE independent sites that all
 * encode the helper bundle's filesystem identifiers must agree, or the
 * packaged helper either fails to launch (ENOENT on spawn) or LaunchServices
 * keys on a name mismatch and re-registers the parent (Dock-tile leak —
 * the original "exec" bug class).
 *
 * The five sites:
 *   1. `packages/core/src/helper-bundle.ts` — exports HELPER_BUNDLE_NAME +
 *      HELPER_EXECUTABLE_NAME, consumed by the desktop spawn site
 *      (`resolve-detached-spawn-args.ts`) AND the CLI self-spawn site
 *      (`packages/cli/src/commands/self-spawn.ts`).
 *   2. `packages/desktop/build/helper-bundle/Info.plist` —
 *      `CFBundleExecutable` declares what macOS expects under the bundle's
 *      MacOS directory.
 *   3. `packages/desktop/scripts/afterPack.mjs` — the path literal that
 *      packages the helper Mach-O into the bundle's MacOS slot.
 *   4. `packages/desktop/electron-builder.yml` — the `extraFiles[].to`
 *      path that lands the source Info.plist at the packaged location.
 *      A rename that propagates to sites 1-3 but misses site 4 would
 *      silently ship the Info.plist at the OLD path while the spawn site
 *      looks for the NEW one — re-opening the dock-leak class via a
 *      partial-rename.
 *   5. `packages/desktop/resources/cli/bin/ok.sh` — the CLI wrapper that
 *      redirects the `ok mcp` / `ok start` ENTRY process to the helper so
 *      its in-process server doesn't park an "exec" Dock tile. A shell
 *      wrapper can't import the TS constants, so it hardcodes the dir +
 *      executable names as string literals.
 *
 * Bundle directory name vs executable basename: these are now distinct.
 * The bundle dir stays descriptive (`OpenKnowledge Server.app`) so
 * operators inspecting `Contents/Frameworks/` can tell what each helper
 * does. The executable basename is constrained to `<productName> Helper`
 * — Electron's helper stub inspects its own basename via
 * `_NSGetExecutablePath()` and silently SIGTRAPs (exit 133, empty stderr)
 * for any name outside its hardcoded {generic, Renderer, GPU, Plugin}
 * type set. Earlier drafts of this test asserted the two names were
 * equal modulo `.app` — that invariant was wrong, and shipping that
 * wrongness in PR #1290 produced the cross-the-board "did not bind a
 * port within 15000ms" startup failure. Runtime guard against
 * regressing the executable-basename constraint:
 * `tests/integration/packaged-helper-runs-as-node.test.ts`.
 *
 * Each site is tested in isolation by `helper-bundle-info-plist.test.ts`
 * (plist shape) and `resolve-detached-spawn-args.test.ts` (TS contract).
 * This file pins their AGREEMENT — a single test that loads all four
 * encodings and asserts they match.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const helperPlistPath = resolve(desktopRoot, 'build/helper-bundle/Info.plist');
const afterPackPath = resolve(desktopRoot, 'scripts/afterPack.mjs');
const electronBuilderYmlPath = resolve(desktopRoot, 'electron-builder.yml');
const okShPath = resolve(desktopRoot, 'resources/cli/bin/ok.sh');

function extractPlistString(content: string, key: string): string | null {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  return content.match(re)?.[1] ?? null;
}

/**
 * `productName` from electron-builder.yml. afterPack.mjs constructs the
 * executable basename as `${appName} Helper` where `appName` resolves to
 * this value at build time. We pin against the YAML at test time so a
 * rename of productName drift-fails here before producing a broken
 * packaged build.
 */
const ELECTRON_BUILDER_PRODUCT_NAME = 'OpenKnowledge';

describe('helper-bundle name agreement across spawn site / Info.plist / afterPack', () => {
  test('CFBundleExecutable in Info.plist matches HELPER_EXECUTABLE_NAME in @inkeep/open-knowledge-core', () => {
    const plist = readFileSync(helperPlistPath, 'utf8');
    const cfBundleExecutable = extractPlistString(plist, 'CFBundleExecutable');
    expect(cfBundleExecutable).toBe(HELPER_EXECUTABLE_NAME);
  });

  test('HELPER_EXECUTABLE_NAME matches Electron canonical `<productName> Helper` basename', () => {
    // Electron's helper stub only accepts the canonical generic-helper name
    // (or the variant forms it knows: Renderer / GPU / Plugin). Any other
    // basename silently SIGTRAPs at launch. afterPack.mjs already constructs
    // the cloned binary name as `${appName} Helper`; this assertion pins the
    // TS constant against the same shape so the three sites agree.
    expect(HELPER_EXECUTABLE_NAME).toBe(`${ELECTRON_BUILDER_PRODUCT_NAME} Helper`);
  });

  test('electron-builder.yml `productName` matches the constant we pin against', () => {
    // A rename of productName in electron-builder.yml without updating
    // this constant + HELPER_EXECUTABLE_NAME would silently produce a
    // bundle whose Mach-O basename is wrong.
    const yml = readFileSync(electronBuilderYmlPath, 'utf8');
    expect(yml).toMatch(new RegExp(`^productName:\\s*${ELECTRON_BUILDER_PRODUCT_NAME}\\s*$`, 'm'));
  });

  test('HELPER_BUNDLE_NAME is a .app and is distinct from `<executable>.app`', () => {
    // The bundle directory name and executable basename are intentionally
    // distinct: the dir name is descriptive (`OpenKnowledge Server.app`),
    // the executable matches Electron's canonical pattern. An earlier
    // draft of this contract asserted `HELPER_BUNDLE_NAME ===
    // \`${HELPER_EXECUTABLE_NAME}.app\``; that invariant turned out to
    // be wrong and caused the shipped SIGTRAP. Pin the negation directly
    // so reverting to the bad pattern fails here.
    expect(HELPER_BUNDLE_NAME).toMatch(/\.app$/);
    expect(HELPER_BUNDLE_NAME).not.toBe(`${HELPER_EXECUTABLE_NAME}.app`);
  });

  test('afterPack.mjs uses `<appName> Helper` as the cloned-binary basename (not a custom name)', () => {
    // afterPack.mjs is a .mjs script (not a TS module) so it doesn't import
    // the TS constants directly. Read the source and assert that the binary
    // name it writes is constructed via the productName template — NOT a
    // hardcoded literal that could drift. The script builds the destination
    // path via `join(...)` with `\`${appName} Helper\`` as the final segment.
    const afterPack = readFileSync(afterPackPath, 'utf8');
    expect(afterPack).toMatch(/`\$\{appName\}\s+Helper`/);
    // And the bundle directory name appears as a quoted literal in join().
    expect(afterPack).toMatch(new RegExp(`['"]${HELPER_BUNDLE_NAME.replace(/\./g, '\\.')}['"]`));
  });

  test('electron-builder.yml extraFiles `to:` value references HELPER_BUNDLE_NAME (not just a YAML comment)', () => {
    // electron-builder.yml is the 4th independent encoding. Its `extraFiles`
    // entry lands the Info.plist at `Frameworks/<HELPER_BUNDLE_NAME>/Contents/
    // Info.plist`. A rename that propagates to sites 1-3 (TS / plist /
    // afterPack) but misses this YAML would silently land the Info.plist at
    // the OLD path; the spawn site looks for the NEW path; dock-leak class
    // reopens via partial-rename.
    //
    // Pin against the OPERATIVE `to:` path, not a stale comment — a bare
    // substring check passes on commentary that mentions the bundle name.
    // The exact YAML shape is `      to: Frameworks/<NAME>/Contents/Info.plist`.
    const yml = readFileSync(electronBuilderYmlPath, 'utf8');
    expect(yml).toMatch(
      new RegExp(
        `^\\s*to:\\s*Frameworks/${HELPER_BUNDLE_NAME.replace(/\./g, '\\.')}/Contents/Info\\.plist\\s*$`,
        'm',
      ),
    );
  });

  test('ok.sh hardcodes the helper bundle path consistent with HELPER_BUNDLE_NAME + HELPER_EXECUTABLE_NAME', () => {
    // The shell wrapper can't import the TS constants, so it encodes the
    // helper path as a literal. Pin that literal against the constants so a
    // rename of either propagates here — otherwise the `ok mcp` / `ok start`
    // redirect would look for a path that no longer exists, silently fall
    // back to the main binary, and re-open the "exec" Dock-tile leak.
    const okSh = readFileSync(okShPath, 'utf8');
    const expectedHelperPath = `Frameworks/${HELPER_BUNDLE_NAME}/Contents/MacOS/${HELPER_EXECUTABLE_NAME}`;
    expect(okSh).toContain(expectedHelperPath);
  });

  test('ok.sh gates the helper redirect to the mcp + start subcommands only', () => {
    // The default `ok` (desktop launch) and every other subcommand must keep
    // the main binary — only the long-lived in-process servers redirect to
    // the Dock-less helper. Pin the `case "$1" in mcp|start)` gate so a
    // refactor that widens it (redirecting the foreground desktop app to the
    // LSUIElement helper) or drops it fails here.
    const okSh = readFileSync(okShPath, 'utf8');
    expect(okSh).toMatch(/case\s+"\$1"\s+in/);
    expect(okSh).toMatch(/mcp\|start\)/);
  });

  test('all five sites agree on the executable name (single string-of-truth)', () => {
    const plist = readFileSync(helperPlistPath, 'utf8');
    const afterPack = readFileSync(afterPackPath, 'utf8');
    const yml = readFileSync(electronBuilderYmlPath, 'utf8');
    const okSh = readFileSync(okShPath, 'utf8');
    const plistName = extractPlistString(plist, 'CFBundleExecutable');

    expect(plistName).toBe(HELPER_EXECUTABLE_NAME);
    expect(plistName).toBe(`${ELECTRON_BUILDER_PRODUCT_NAME} Helper`);
    expect(afterPack).toMatch(/`\$\{appName\}\s+Helper`/);
    expect(yml).toMatch(
      new RegExp(
        `^\\s*to:\\s*Frameworks/${HELPER_BUNDLE_NAME.replace(/\./g, '\\.')}/Contents/Info\\.plist\\s*$`,
        'm',
      ),
    );
    expect(okSh).toContain(
      `Frameworks/${HELPER_BUNDLE_NAME}/Contents/MacOS/${HELPER_EXECUTABLE_NAME}`,
    );
  });
});
