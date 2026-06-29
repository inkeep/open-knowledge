import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const buildDir = resolve(desktopRoot, 'build');
const mainPlist = resolve(buildDir, 'entitlements.mac.plist');
const inheritPlist = resolve(buildDir, 'entitlements.mac.inherit.plist');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');

const HELPER_FORBIDDEN_KEYS = [
  'com.apple.developer.associated-domains',
  'com.apple.security.files.user-selected.read-write',
  'com.apple.security.files.bookmarks.app-scope',
] as const;

const HELPER_REQUIRED_KEYS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.inherit',
] as const;

function extractKeys(plistContent: string): string[] {
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
    const match = yml.match(/^\s*entitlementsInherit:\s*(\S+)/m);
    expect(match, 'entitlementsInherit not declared in electron-builder.yml').not.toBeNull();
    const value = match?.[1];
    expect(value).toBe('build/entitlements.mac.inherit.plist');
    expect(value).not.toBe('build/entitlements.mac.plist');
  });

  test('electron-builder.yml entitlements (main-app) points at the main plist (not the helper plist)', () => {
    const yml = readFileSync(builderYml, 'utf8');
    const match = yml.match(/^\s*entitlements(?!Inherit):\s*(\S+)/m);
    expect(match, 'entitlements (main-app) not declared in electron-builder.yml').not.toBeNull();
    const value = match?.[1];
    expect(value).toBe('build/entitlements.mac.plist');
    expect(value).not.toBe('build/entitlements.mac.inherit.plist');
  });

  test('main-app plist still carries the restricted + file-access entitlements (regression guard)', () => {
    const content = readFileSync(mainPlist, 'utf8');
    const keys = extractKeys(content);
    for (const required of HELPER_FORBIDDEN_KEYS) {
      expect(keys, `${required} must appear in main-app entitlements`).toContain(required);
    }
  });

  test('helper plist contains no keys beyond the required set (allowlist)', () => {
    const content = readFileSync(inheritPlist, 'utf8');
    const keys = extractKeys(content);
    const allowed = new Set<string>(HELPER_REQUIRED_KEYS as readonly string[]);
    const unexpected = keys.filter((k) => !allowed.has(k));
    expect(unexpected, `Unexpected keys in helper plist: ${unexpected.join(', ')}`).toHaveLength(0);
  });
});
