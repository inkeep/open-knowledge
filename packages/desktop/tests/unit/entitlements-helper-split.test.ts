import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Helper-process entitlements MUST NOT include restricted entitlements (those
 * requiring an embedded provisioning profile) or file-access entitlements
 * granted to the main app. Helper-only entitlements (e.g. `inherit`,
 * `allow-dyld-environment-variables`) MAY be present even when absent from
 * the main plist — the contract is "no forbidden keys + all required keys,"
 * not strict subset. (Earlier drafts of this file used "strict subset"
 * phrasing — that was inaccurate because the helper plist legitimately
 * carries `cs.allow-dyld-environment-variables` + `security.inherit`, both
 * helper-bootstrap-specific and meaningless on the main binary.)
 *
 * macOS Hardened Runtime validates child-process entitlements at AMFI/SIP
 * enforcement. Restricted entitlements (those gated by a provisioning profile,
 * notably `com.apple.developer.associated-domains`) are granted to the MAIN
 * binary via the embedded `embedded.provisionprofile`. Helper binaries
 * (Renderer.app / GPU.app / Plugin.app / generic Helper.app spawned by
 * `utilityProcess.fork`) do NOT carry an embedded profile — so if a helper's
 * signature claims a restricted entitlement, macOS rejects the launch with
 * SIGKILL (parent observes `exit_code=9`).
 *
 * macOS 26.4.x ("Tahoe") tightened this enforcement compared to earlier
 * macOS 26.x point releases — the same overly-broad inherited entitlements
 * that booted fine on macOS 26.2.x now SIGKILL helpers on 26.4.1. Symptom:
 *
 *   - Project window: "Unable to open project … utility exited before ready
 *     (code=9)" dialog + GPU process exit_code=9 in stderr.
 *   - Eventually: `FATAL: GPU process isn't usable. Goodbye.` and the main
 *     process dies.
 *
 * Fix: separate `entitlements.mac.inherit.plist` for `entitlementsInherit`
 * carrying ONLY entitlements every helper-process class can legally claim
 * — JIT trio + dyld env vars + inherit. The main-app file (`entitlements
 * .mac.plist`) keeps the restricted associated-domains + file-access
 * entitlements that helpers don't need and can't legally hold without
 * a profile.
 *
 * This file enforces the contract structurally. Adding an entitlement to
 * `entitlements.mac.plist` that's safe-for-helpers is fine — add it to
 * the inherit plist too. Adding one that's helper-illegal (restricted,
 * file-access, anything that requires a profile) MUST stay out of the
 * inherit plist.
 *
 * Related: build/UNIVERSAL_LINK_ACTIVATION.md (associated-domains setup).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const buildDir = resolve(desktopRoot, 'build');
const mainPlist = resolve(buildDir, 'entitlements.mac.plist');
const inheritPlist = resolve(buildDir, 'entitlements.mac.inherit.plist');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');

/**
 * Entitlements that MUST NOT appear in a helper-process plist.
 *
 * `com.apple.developer.associated-domains` is the load-bearing one — it's
 * a restricted entitlement requiring an embedded `.provisionprofile` to
 * grant, and helpers don't carry one. With it set on a helper, macOS
 * 26.4.x's AMFI sends SIGKILL.
 *
 * The `com.apple.security.files.*` pair is a defense-in-depth exclusion —
 * helpers shouldn't independently access user-selected files (the main
 * app brokers file access via NSOpenPanel + security-scoped bookmarks).
 * Including them in the helper plist isn't the load-bearing killer the
 * way associated-domains is, but they're inappropriate for helpers and
 * tightened AMFI enforcement may reject them in future macOS versions.
 */
const HELPER_FORBIDDEN_KEYS = [
  'com.apple.developer.associated-domains',
  'com.apple.security.files.user-selected.read-write',
  'com.apple.security.files.bookmarks.app-scope',
] as const;

/**
 * Entitlements that the helper plist MUST include for Electron 41+ on
 * macOS Hardened Runtime to function.
 *
 * - `cs.allow-jit` / `cs.allow-unsigned-executable-memory` — V8 JIT
 * - `cs.disable-library-validation` — required for Electron's native
 *   modules (notably `@napi-rs/keyring`, `@parcel/watcher`) to dlopen
 *   without library-validation rejecting non-system signatures.
 * - `cs.allow-dyld-environment-variables` — Electron's helper bootstrap
 *   uses `DYLD_INSERT_LIBRARIES` for code injection; without this the
 *   helper SIGKILLs at process start.
 * - `inherit` — explicit opt-in to inherited entitlements from the parent
 *   process, the Apple-blessed pattern for child processes.
 */
const HELPER_REQUIRED_KEYS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.inherit',
] as const;

function extractKeys(plistContent: string): string[] {
  // Match `<key>some.key.name</key>` — XML plist canonical form. Tolerates
  // arbitrary whitespace + indentation. Not a full plist parser; the
  // structural assertion is "this key is mentioned" not "this key has a
  // specific value-shape" — every entitlement in HELPER_FORBIDDEN_KEYS /
  // HELPER_REQUIRED_KEYS is a boolean true or an array of strings, and
  // mention-without-true is not a real-world pattern in plists shipped to
  // codesign.
  const matches = plistContent.matchAll(/<key>([^<]+)<\/key>/g);
  return Array.from(matches, (m) => m[1]);
}

describe('macOS helper-process entitlements (Tahoe AMFI compliance)', () => {
  test('build/entitlements.mac.inherit.plist exists', () => {
    expect(existsSync(inheritPlist)).toBe(true);
  });

  test('helper plist is well-formed XML and parseable', () => {
    expect(existsSync(inheritPlist)).toBe(true);
    const content = readFileSync(inheritPlist, 'utf8');
    expect(content).toContain('<?xml version="1.0"');
    expect(content).toContain('<!DOCTYPE plist');
    expect(content).toContain('<dict>');
    expect(content).toContain('</dict>');
    expect(content).toContain('</plist>');
  });

  test('helper plist does NOT include restricted or main-app-only entitlements', () => {
    const content = readFileSync(inheritPlist, 'utf8');
    const keys = extractKeys(content);
    for (const forbidden of HELPER_FORBIDDEN_KEYS) {
      expect(keys, `${forbidden} must NOT appear in helper entitlements`).not.toContain(forbidden);
    }
  });

  test('helper plist includes every entitlement Electron helpers need', () => {
    const content = readFileSync(inheritPlist, 'utf8');
    const keys = extractKeys(content);
    for (const required of HELPER_REQUIRED_KEYS) {
      expect(keys, `${required} must appear in helper entitlements`).toContain(required);
    }
  });

  test('electron-builder.yml entitlementsInherit points at the helper plist (not the main plist)', () => {
    const yml = readFileSync(builderYml, 'utf8');
    // Drop trailing `\s*$` anchor — fragile to inline YAML comments
    // (`entitlementsInherit: build/foo.plist  # comment`). The explicit
    // .toBe() below validates correctness; the anchor adds no protection.
    const match = yml.match(/^\s*entitlementsInherit:\s*(\S+)/m);
    expect(match, 'entitlementsInherit not declared in electron-builder.yml').not.toBeNull();
    const value = match?.[1];
    // The shared-file anti-pattern: entitlementsInherit pointing at the
    // main plist. macOS 26.4.x's AMFI enforcement is the reason this is
    // load-bearing.
    expect(value).toBe('build/entitlements.mac.inherit.plist');
    expect(value).not.toBe('build/entitlements.mac.plist');
  });

  test('electron-builder.yml entitlements (main-app) points at the main plist (not the helper plist)', () => {
    // Symmetric guard: if the two YAML values get swapped, the inherit
    // assertion above still passes (helper plist still exists, still has
    // forbidden-excluded + required-included), but the main binary now
    // points at a plist with NO `associated-domains` — silently breaks
    // Universal Links at the next signed build (and codesign rejects the
    // build at notarize: "not authorized to use restricted entitlement"
    // can't fire on the inherit plist that has no restricted keys).
    // Negative lookahead matches `entitlements:` but NOT
    // `entitlementsInherit:`.
    const yml = readFileSync(builderYml, 'utf8');
    // Same anchor-fragility consideration as the inherit assertion above.
    const match = yml.match(/^\s*entitlements(?!Inherit):\s*(\S+)/m);
    expect(match, 'entitlements (main-app) not declared in electron-builder.yml').not.toBeNull();
    const value = match?.[1];
    expect(value).toBe('build/entitlements.mac.plist');
    expect(value).not.toBe('build/entitlements.mac.inherit.plist');
  });

  test('main-app plist still carries the restricted + file-access entitlements (regression guard)', () => {
    // Pin every entitlement the main app needs that helpers must NOT have.
    // Dropping any of these from the main plist:
    //   - associated-domains → breaks Universal Link handoff (build
    //     /UNIVERSAL_LINK_ACTIVATION.md) and fails notarization with
    //     "not authorized to use restricted entitlement" if the
    //     provisioning profile claims it but the plist doesn't.
    //   - files.user-selected.read-write → breaks the NSOpenPanel /
    //     NSSavePanel project-picker flow on hardened-runtime builds.
    //   - files.bookmarks.app-scope → breaks security-scoped bookmark
    //     persistence (project paths the user previously granted access
    //     to fail to re-resolve on next launch).
    // This is the symmetric guard to HELPER_FORBIDDEN_KEYS above — those
    // keys are forbidden in the helper plist and required in the main.
    const content = readFileSync(mainPlist, 'utf8');
    const keys = extractKeys(content);
    for (const required of HELPER_FORBIDDEN_KEYS) {
      expect(keys, `${required} must appear in main-app entitlements`).toContain(required);
    }
  });

  test('helper plist contains no keys beyond the required set (allowlist)', () => {
    // Defense-in-depth on top of HELPER_FORBIDDEN_KEYS exclusion: the
    // blocklist only catches CURRENTLY-known restricted entitlements.
    // A future hardening pass on the main plist (e.g. adding
    // `com.apple.developer.network.client` for a new platform feature)
    // could propagate to the helper via copy-paste; this allowlist
    // forces conscious opt-in to any new helper entitlement.
    const content = readFileSync(inheritPlist, 'utf8');
    const keys = extractKeys(content);
    const allowed = new Set<string>(HELPER_REQUIRED_KEYS as readonly string[]);
    const unexpected = keys.filter((k) => !allowed.has(k));
    expect(unexpected, `Unexpected keys in helper plist: ${unexpected.join(', ')}`).toHaveLength(0);
  });
});
