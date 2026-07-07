import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for the helper-bundle Info.plist shipped alongside the
 * packaged desktop. The detached server (`spawnDetachedServer` in
 * `packages/desktop/src/main/index.ts`) targets the helper bundle's MacOS
 * binary, and the helper's Info.plist is what tells macOS LaunchServices
 * to launch the spawned process WITHOUT a Dock tile.
 *
 * `LSUIElement=true` is the load-bearing key — without it, the helper
 * binary's `.app` association causes `coreservicesd` to register a Dock
 * tile that never resolves (the "exec" placeholder bug).
 *
 * `CFBundleIdentifier=com.inkeep.open-knowledge.server` namespaces the
 * helper under the parent's `com.inkeep.open-knowledge` bundle ID so
 * LaunchServices treats it as a distinct application registration.
 *
 * Drift between this plist and the spawn target in
 * `resolve-detached-spawn-args.ts` would reintroduce the Dock leak. The
 * file is shipped via electron-builder.yml `extraFiles` to
 * `Frameworks/OpenKnowledge Server.app/Contents/Info.plist`; the
 * matching MacOS binary is dropped into place by `scripts/afterPack.mjs`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const helperPlistPath = resolve(desktopRoot, 'build/helper-bundle/Info.plist');

function extractStringValue(content: string, key: string): string | null {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  return content.match(re)?.[1] ?? null;
}

function hasBooleanTrueKey(content: string, key: string): boolean {
  const re = new RegExp(`<key>${key}</key>\\s*<true\\s*/>`);
  return re.test(content);
}

describe('helper-bundle Info.plist (detached-server Dock-leak regression guard)', () => {
  test('build/helper-bundle/Info.plist exists', () => {
    expect(existsSync(helperPlistPath)).toBe(true);
  });

  test('helper plist is well-formed XML and parseable', () => {
    const content = readFileSync(helperPlistPath, 'utf8');
    expect(content).toContain('<?xml version="1.0"');
    expect(content).toContain('<!DOCTYPE plist');
    expect(content).toContain('<dict>');
    expect(content).toContain('</dict>');
    expect(content).toContain('</plist>');
  });

  test('LSUIElement=true — suppresses the macOS Dock tile for the spawned helper', () => {
    const content = readFileSync(helperPlistPath, 'utf8');
    expect(hasBooleanTrueKey(content, 'LSUIElement')).toBe(true);
  });

  test('CFBundleIdentifier is namespaced under the parent bundle ID', () => {
    const content = readFileSync(helperPlistPath, 'utf8');
    expect(extractStringValue(content, 'CFBundleIdentifier')).toBe(
      'com.inkeep.open-knowledge.server',
    );
  });

  test('CFBundleExecutable is "OpenKnowledge Helper" — Electron canonical generic-helper name', () => {
    // Electron's helper stub inspects its own `_NSGetExecutablePath()` basename
    // early in boot and silently SIGTRAPs (exit 133, empty stderr) for any
    // name outside its hardcoded {generic, Renderer, GPU, Plugin} type set.
    // The bundle directory name `OpenKnowledge Server.app` is descriptive;
    // the executable basename has to be the canonical `<productName> Helper`.
    // Runtime guard: tests/integration/packaged-helper-runs-as-node.test.ts.
    const content = readFileSync(helperPlistPath, 'utf8');
    expect(extractStringValue(content, 'CFBundleExecutable')).toBe('OpenKnowledge Helper');
  });

  test('CFBundlePackageType=APPL (canonical .app bundle marker)', () => {
    const content = readFileSync(helperPlistPath, 'utf8');
    expect(extractStringValue(content, 'CFBundlePackageType')).toBe('APPL');
  });

  test('LSEnvironment.MallocNanoZone=0 — mirrors Electron sibling helpers', () => {
    // Non-load-bearing for the SIGTRAP class (verified empirically — the
    // trap persisted with this key set when the basename was wrong). Kept
    // for structural parity with the {generic, Renderer, GPU, Plugin}
    // helper bundles so future macOS releases that tighten requirements
    // around helper-bundle shape don't catch this bundle alone.
    const content = readFileSync(helperPlistPath, 'utf8');
    expect(content).toMatch(
      /<key>LSEnvironment<\/key>\s*<dict>[\s\S]*?<key>MallocNanoZone<\/key>\s*<string>0<\/string>/,
    );
  });
});
