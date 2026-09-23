import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_PRODUCTS, desktopWindowsExecutableName } from '@inkeep/open-knowledge-core';
import {
  HELPER_BUNDLE_NAME,
  HELPER_EXECUTABLE_NAME,
} from '@inkeep/open-knowledge-core/helper-bundle';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const helperPlistPath = resolve(desktopRoot, 'build/helper-bundle/Info.plist');
const afterPackPath = resolve(desktopRoot, 'scripts/afterPack.mjs');
const electronBuilderYmlPath = resolve(desktopRoot, 'electron-builder.yml');
const okShPath = resolve(desktopRoot, 'resources/cli/bin/ok.sh');
const okCmdPath = resolve(desktopRoot, 'resources/cli/bin/ok.cmd');
const okPs1Path = resolve(desktopRoot, 'resources/cli/bin/ok.ps1');
const okLinuxPath = resolve(desktopRoot, 'resources/cli/bin/ok-linux.sh');

function extractPlistString(content: string, key: string): string | null {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  return content.match(re)?.[1] ?? null;
}

const ELECTRON_BUILDER_PRODUCT_NAME = 'OpenKnowledge';

describe('helper-bundle name agreement across spawn site / Info.plist / afterPack', () => {
  test('CFBundleExecutable in Info.plist matches HELPER_EXECUTABLE_NAME in @inkeep/open-knowledge-core', () => {
    const plist = readFileSync(helperPlistPath, 'utf8');
    const cfBundleExecutable = extractPlistString(plist, 'CFBundleExecutable');
    expect(cfBundleExecutable).toBe(HELPER_EXECUTABLE_NAME);
  });

  test('HELPER_EXECUTABLE_NAME matches Electron canonical `<productName> Helper` basename', () => {
    expect(HELPER_EXECUTABLE_NAME).toBe(`${ELECTRON_BUILDER_PRODUCT_NAME} Helper`);
  });

  test('electron-builder.yml `productName` matches the constant we pin against', () => {
    const yml = readFileSync(electronBuilderYmlPath, 'utf8');
    expect(yml).toMatch(new RegExp(`^productName:\\s*${ELECTRON_BUILDER_PRODUCT_NAME}\\s*$`, 'm'));
  });

  test('HELPER_BUNDLE_NAME is a .app and is distinct from `<executable>.app`', () => {
    expect(HELPER_BUNDLE_NAME).toMatch(/\.app$/);
    expect(HELPER_BUNDLE_NAME).not.toBe(`${HELPER_EXECUTABLE_NAME}.app`);
  });

  test('afterPack.mjs derives the helper bundle and executable from the product name', () => {
    const afterPack = readFileSync(afterPackPath, 'utf8');
    expect(afterPack).toMatch(/`\$\{appName\}\s+Helper`/);
    expect(afterPack).toMatch(/`\$\{appName\} Server\.app`/);
  });

  test('electron-builder.yml extraFiles `to:` value references HELPER_BUNDLE_NAME (not just a YAML comment)', () => {
    const yml = readFileSync(electronBuilderYmlPath, 'utf8');
    expect(yml).toMatch(
      new RegExp(
        `^\\s*to:\\s*Frameworks/${HELPER_BUNDLE_NAME.replace(/\./g, '\\.')}/Contents/Info\\.plist\\s*$`,
        'm',
      ),
    );
  });

  test('ok.sh derives the helper path from its enclosing app bundle', () => {
    const okSh = readFileSync(okShPath, 'utf8');
    expect(okSh).toContain('APP_NAME="$(basename "$APP_PATH" .app)"');
    expect(okSh).toContain('Frameworks/$APP_NAME Server.app/Contents/MacOS/$APP_NAME Helper');
  });

  test('ok.sh gates the helper redirect to the mcp + start subcommands only', () => {
    const okSh = readFileSync(okShPath, 'utf8');
    expect(okSh).toMatch(/case\s+"\$1"\s+in/);
    expect(okSh).toMatch(/mcp\|start\)/);
  });

  test('platform wrappers recognize every packaged desktop executable', () => {
    const cmd = readFileSync(okCmdPath, 'utf8');
    const ps1 = readFileSync(okPs1Path, 'utf8');
    const linux = readFileSync(okLinuxPath, 'utf8');
    for (const product of Object.values(DESKTOP_PRODUCTS)) {
      expect(cmd).toContain(`"${desktopWindowsExecutableName(product)}"`);
      expect(ps1).toContain(`'${desktopWindowsExecutableName(product)}'`);
      expect(linux).toContain(product.linuxExecutableName);
    }
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
    expect(okSh).toContain('Frameworks/$APP_NAME Server.app/Contents/MacOS/$APP_NAME Helper');
  });
});
