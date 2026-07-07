import { dirname, join } from 'node:path';

/**
 * Helper bundle filesystem identifiers + the pure path-arithmetic resolver
 * that maps a packaged macOS app's main-binary path to the
 * `LSUIElement=true` helper bundle alongside it.
 *
 * Background — why the helper bundle exists. On darwin packaged builds,
 * `process.execPath` resolves to `<parent .app>/Contents/MacOS/<MainBinary>`.
 * Calling `child_process.spawn` on that path detached (even with
 * `ELECTRON_RUN_AS_NODE=1`) makes macOS LaunchServices register a duplicate
 * `.app` launch — `coreservicesd` then parks a generic "exec" Dock
 * placeholder for the lifetime of the child. Spawning the sibling helper
 * bundle (whose `Info.plist` declares `LSUIElement=true`) is the canonical
 * Apple convention for a Dock-less helper process (the same shape Electron
 * uses for its own `Electron Helper.app`).
 *
 * Five independent encodings of the bundle dir name + executable basename
 * must agree, or the packaged helper either fails to launch (ENOENT) or
 * LaunchServices keys on a name mismatch and falls back to the parent's
 * registration (re-opens the Dock-leak class):
 *
 *   1. This module's `resolveHelperBundleBinary` (the path-arithmetic
 *      resolver) — the single TS source of the bundle dir name and
 *      executable basename. Two consumers compose it: the desktop spawn
 *      site (`packages/desktop/src/main/resolve-detached-spawn-args.ts`)
 *      AND the CLI self-spawn redirect (`packages/cli/src/commands/self-spawn.ts`).
 *      They use DIFFERENT gating predicates over this same resolver — the
 *      desktop has Electron's `app.isPackaged`; the CLI runs under
 *      `ELECTRON_RUN_AS_NODE` and has no such signal, so it infers the
 *      packaged shape from a `.app/Contents/MacOS/` regex plus an
 *      `exists` probe. Consumers, not independent encodings — they cannot
 *      drift from the resolver because they import its return value.
 *   2. `packages/desktop/build/helper-bundle/Info.plist`'s `CFBundleExecutable`.
 *   3. `packages/desktop/scripts/afterPack.mjs`'s clone-target path literal.
 *   4. `packages/desktop/electron-builder.yml`'s `extraFiles[].to` path.
 *   5. `packages/desktop/resources/cli/bin/ok.sh`'s hardcoded helper path —
 *      the `ok mcp` / `ok start` entry process redirects to the helper so its
 *      in-process server doesn't park an "exec" Dock tile against the main
 *      binary. A shell wrapper can't import the TS constants, so it encodes
 *      the dir + executable names as string literals.
 *
 * Cross-reference test: `packages/desktop/tests/unit/helper-bundle-name-agreement.test.ts`.
 *
 * The executable name MUST be `<productName> Helper`. Electron's helper
 * binary inspects its own basename via `_NSGetExecutablePath()` early in
 * boot and only accepts the canonical generic-helper name (or the variant
 * forms `Helper (Renderer)` / `Helper (GPU)` / `Helper (Plugin)`). Any
 * other basename — including descriptive choices like "OpenKnowledge
 * Server" or invented variants like "Helper (Server)" — silently SIGTRAPs
 * with no stderr before `ELECTRON_RUN_AS_NODE` is consulted. We use the
 * generic-helper name and disambiguate from the existing utility helper
 * via the bundle directory (`.../OpenKnowledge Server.app/...`) rather
 * than via the executable filename.
 */
export const HELPER_BUNDLE_NAME = 'OpenKnowledge Server.app';
export const HELPER_EXECUTABLE_NAME = 'OpenKnowledge Helper';

/**
 * Given the parent app's main-binary path
 * (`<.app>/Contents/MacOS/<MainBinary>`), return the absolute path of the
 * helper bundle's executable inside the parent's `Contents/Frameworks/`.
 * Pure path arithmetic — does not consult the filesystem.
 */
export function resolveHelperBundleBinary(parentExecPath: string): string {
  return join(
    dirname(parentExecPath),
    '..',
    'Frameworks',
    HELPER_BUNDLE_NAME,
    'Contents',
    'MacOS',
    HELPER_EXECUTABLE_NAME,
  );
}
