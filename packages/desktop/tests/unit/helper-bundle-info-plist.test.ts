import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


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
    const content = readFileSync(helperPlistPath, 'utf8');
    expect(extractStringValue(content, 'CFBundleExecutable')).toBe('OpenKnowledge Helper');
  });

  test('CFBundlePackageType=APPL (canonical .app bundle marker)', () => {
    const content = readFileSync(helperPlistPath, 'utf8');
    expect(extractStringValue(content, 'CFBundlePackageType')).toBe('APPL');
  });

  test('LSEnvironment.MallocNanoZone=0 — mirrors Electron sibling helpers', () => {
    const content = readFileSync(helperPlistPath, 'utf8');
    expect(content).toMatch(
      /<key>LSEnvironment<\/key>\s*<dict>[\s\S]*?<key>MallocNanoZone<\/key>\s*<string>0<\/string>/,
    );
  });
});
