
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { RENDERER_DEDUPE } from '../../vite.dedupe';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const APP_VITE_CONFIG = resolve(REPO_ROOT, 'packages/app/vite.config.ts');
const DESKTOP_VITE_CONFIG = resolve(REPO_ROOT, 'packages/desktop/electron.vite.config.ts');

const SHARED_DEDUPE_IDENTIFIER = 'RENDERER_DEDUPE';

interface DedupeInfo {
  readonly file: string;
  readonly inlineEntries: readonly string[];
  readonly spreadIdentifiers: readonly string[];
  readonly elementCount: number;
  readonly line: number;
}

function extractDedupeArrays(filePath: string): DedupeInfo[] {
  const project = new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      noLib: true,
      allowJs: false,
    },
  });
  const sf = project.addSourceFileAtPath(filePath);
  const out: DedupeInfo[] = [];
  for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const nameNode = prop.getNameNode();
    const nameText = nameNode.isKind(SyntaxKind.Identifier)
      ? nameNode.getText()
      : nameNode.isKind(SyntaxKind.StringLiteral)
        ? nameNode.getLiteralText()
        : null;
    if (nameText !== 'dedupe') continue;
    const initializer = prop.getInitializer();
    if (!initializer?.isKind(SyntaxKind.ArrayLiteralExpression)) continue;
    const inlineEntries: string[] = [];
    const spreadIdentifiers: string[] = [];
    let elementCount = 0;
    for (const el of initializer.getElements()) {
      elementCount += 1;
      if (
        el.isKind(SyntaxKind.StringLiteral) ||
        el.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
      ) {
        inlineEntries.push(el.getLiteralText());
      } else if (el.isKind(SyntaxKind.SpreadElement)) {
        const inner = el.getExpression();
        if (inner.isKind(SyntaxKind.Identifier)) {
          spreadIdentifiers.push(inner.getText());
        }
      }
    }
    out.push({
      file: filePath,
      inlineEntries,
      spreadIdentifiers,
      elementCount,
      line: prop.getStartLineNumber(),
    });
  }
  return out;
}

describe('vite + electron-vite dedupe parity', () => {
  test('both configs declare exactly one resolve.dedupe array', () => {
    const appArrays = extractDedupeArrays(APP_VITE_CONFIG);
    const desktopArrays = extractDedupeArrays(DESKTOP_VITE_CONFIG);
    expect(appArrays).toHaveLength(1);
    expect(desktopArrays).toHaveLength(1);
  });

  test('both configs spread the same shared dedupe constant', () => {
    const [appInfo] = extractDedupeArrays(APP_VITE_CONFIG);
    const [desktopInfo] = extractDedupeArrays(DESKTOP_VITE_CONFIG);
    expect(appInfo?.spreadIdentifiers).toContain(SHARED_DEDUPE_IDENTIFIER);
    expect(desktopInfo?.spreadIdentifiers).toContain(SHARED_DEDUPE_IDENTIFIER);
  });

  test('shared RENDERER_DEDUPE has at least one entry (anti-vacuousness floor)', () => {
    expect(RENDERER_DEDUPE.length).toBeGreaterThan(0);
  });

  test('both configs contain the same dedupe entries (inline literals + spreads agree)', () => {
    const [appInfo] = extractDedupeArrays(APP_VITE_CONFIG);
    const [desktopInfo] = extractDedupeArrays(DESKTOP_VITE_CONFIG);
    if (!appInfo || !desktopInfo) {
      throw new Error(
        'expected both configs to expose a dedupe array (prior test should have failed)',
      );
    }
    const appInline = new Set(appInfo.inlineEntries);
    const desktopInline = new Set(desktopInfo.inlineEntries);
    const appSpreads = new Set(appInfo.spreadIdentifiers);
    const desktopSpreads = new Set(desktopInfo.spreadIdentifiers);

    const onlyInAppInline = [...appInline].filter((e) => !desktopInline.has(e)).sort();
    const onlyInDesktopInline = [...desktopInline].filter((e) => !appInline.has(e)).sort();
    const onlyInAppSpreads = [...appSpreads].filter((s) => !desktopSpreads.has(s)).sort();
    const onlyInDesktopSpreads = [...desktopSpreads].filter((s) => !appSpreads.has(s)).sort();

    if (
      onlyInAppInline.length > 0 ||
      onlyInDesktopInline.length > 0 ||
      onlyInAppSpreads.length > 0 ||
      onlyInDesktopSpreads.length > 0
    ) {
      const lines: string[] = [
        `Vite + electron-vite dedupe lists drift.`,
        `Both configs must declare the same dedupe entries (inline literals + spread`,
        `identifiers) — a y-* dependency in one but not the other reintroduces the`,
        `dual-import failure mode the dedupe gate closes.`,
      ];
      if (onlyInAppInline.length > 0) {
        lines.push(`  Inline entries only in packages/app/vite.config.ts:`);
        for (const entry of onlyInAppInline) lines.push(`    - ${entry}`);
      }
      if (onlyInDesktopInline.length > 0) {
        lines.push(`  Inline entries only in packages/desktop/electron.vite.config.ts:`);
        for (const entry of onlyInDesktopInline) lines.push(`    - ${entry}`);
      }
      if (onlyInAppSpreads.length > 0) {
        lines.push(`  Spread identifiers only in packages/app/vite.config.ts:`);
        for (const id of onlyInAppSpreads) lines.push(`    - ...${id}`);
      }
      if (onlyInDesktopSpreads.length > 0) {
        lines.push(`  Spread identifiers only in packages/desktop/electron.vite.config.ts:`);
        for (const id of onlyInDesktopSpreads) lines.push(`    - ...${id}`);
      }
      throw new Error(lines.join('\n'));
    }

    expect(appInline.size).toBe(desktopInline.size);
    expect(appSpreads.size).toBe(desktopSpreads.size);
    expect(appInfo.elementCount).toBe(desktopInfo.elementCount);
  });
});
