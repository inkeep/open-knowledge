/**
 * Vite + electron-vite dedupe parity meta-test.
 *
 * Pins the cross-config invariant that
 * `packages/app/vite.config.ts`'s `resolve.dedupe` array and
 * `packages/desktop/electron.vite.config.ts`'s renderer-block
 * `resolve.dedupe` array contain the same entries.
 *
 * Why a meta-test (rather than extracting to a shared module): both vite
 * configs are top-level config files consumed by their respective build
 * tools (vite + electron-vite), and a shared module would need to be
 * importable from both sides without crossing package boundaries that
 * those build tools handle awkwardly. The arrays are small and rarely
 * change — the lower-friction discipline is a build-time assertion that
 * the two lists agree, with the file-level "Duplicated from..." comment
 * pointing readers at the partner config when a future contributor edits
 * one and forgets the other.
 *
 * Why parity matters: the dedupe list closes a real failure mode (mixed
 * CJS/ESM resolution of y-* intermediaries causing two yjs evaluations in
 * the same realm). A future PR adding a y-* dependency to one config but
 * not the other reintroduces that failure mode silently —
 * `y-prosemirror-import-coverage.test.ts` doesn't gate the dedupe lists,
 * only the renderer's source imports.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { RENDERER_DEDUPE } from '../../vite.dedupe';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const APP_VITE_CONFIG = resolve(REPO_ROOT, 'packages/app/vite.config.ts');
const DESKTOP_VITE_CONFIG = resolve(REPO_ROOT, 'packages/desktop/electron.vite.config.ts');

/**
 * Identifier name of the shared dedupe constant. Both configs MUST consume
 * this single source of truth via `dedupe: [...RENDERER_DEDUPE]`. The shared
 * module is imported by `vite.config.ts` and `electron.vite.config.ts`; this
 * meta-test pins the structural shape of that consumption so a future
 * contributor adding inline literal entries (`dedupe: [...RENDERER_DEDUPE,
 * 'y-newpkg']`) to one config but not the other can't slip past review.
 */
const SHARED_DEDUPE_IDENTIFIER = 'RENDERER_DEDUPE';

interface DedupeInfo {
  readonly file: string;
  /** String-literal entries appearing inline alongside any spreads. */
  readonly inlineEntries: readonly string[];
  /** Identifier names spread into the array, e.g. `RENDERER_DEDUPE`. */
  readonly spreadIdentifiers: readonly string[];
  /** Total element count (sum of inline literals, spreads, and any other elements). */
  readonly elementCount: number;
  readonly line: number;
}

/**
 * Extract every `dedupe: [...]` array literal in the file and return its
 * shape — string-literal entries, spread-identifier names, and element
 * count. Uses ts-morph for robust handling of comments, multi-line
 * literals, spread elements (`...RENDERER_DEDUPE`), and nested
 * `resolve.dedupe` patterns inside multiple build sections.
 *
 * Spread tracking matters because both vite configs consume a shared
 * `RENDERER_DEDUPE` constant via `dedupe: [...RENDERER_DEDUPE]`. A naive
 * extractor that only collects string literals would return `entries: []`
 * for both files (the spread is neither a `StringLiteral` nor a
 * `NoSubstitutionTemplateLiteral`), making any byte-set parity test
 * trivially pass. Tracking the spread identifier is what gates that both
 * configs reference the SAME shared constant — and tracking inline entries
 * is what catches a contributor adding `[...RENDERER_DEDUPE, 'y-newpkg']`
 * to one config but not the other.
 *
 * Returns the per-file dedupe info — vite.config.ts has one (top-level
 * resolve.dedupe), electron.vite.config.ts has one (renderer.resolve.dedupe
 * inside the multi-section config). If a future config grows to multiple,
 * this surfaces the assumption with a precise count assertion.
 */
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
    // Without this, a future regression that empties RENDERER_DEDUPE would
    // make every other parity test trivially pass — both configs reference
    // an empty array. This pins the load-bearing claim that the shared
    // constant carries the actual y-* + prosemirror-* dedupe list.
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
