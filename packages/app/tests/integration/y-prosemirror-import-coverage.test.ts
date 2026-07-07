/**
 * y-prosemirror import coverage meta-test.
 *
 * Pins the single-prosemirror-binding-stack invariant: the renderer imports
 * `ySyncPluginKey` / `yUndoPluginKey` / any other prosemirror-binding-stack
 * symbol from `@tiptap/y-tiptap` (TipTap v3 official path) and NEVER from
 * `y-prosemirror` directly. The two libraries are sibling-by-construction —
 * both ship `new PluginKey('y-sync')` at module load — so a renderer that
 * imports from BOTH ends up with two distinct PluginKey instances. That
 * silently breaks `Y.UndoManager.trackedOrigins` Set-by-identity matching
 * across the edit (sync) and undo paths, classifying transactions wrong and
 * (most visibly) skipping or replaying the wrong undo step.
 *
 * Failure mode: developer copies an example from upstream y-prosemirror docs
 * (e.g., `import { ySyncPluginKey } from 'y-prosemirror'`) and lands a PR
 * that brings the second stack back into the renderer. This test fails the
 * build at PR time with a precise file:line message.
 *
 * Architectural mirror: matches the pattern from
 * `error-envelope-coverage.test.ts` and `exhaustiveness-coverage.test.ts` —
 * static AST/regex scan over a fixed source root, fail-on-any-occurrence.
 *
 * Indirect inclusion is acceptable. `@tiptap/extension-collaboration-cursor`
 * peer-deps `y-prosemirror`, so it may exist in `node_modules` and be
 * deduped via `vite.dedupe.ts`'s `RENDERER_DEDUPE`. What this test forbids
 * is DIRECT imports in renderer source — the dual-stack symptom requires
 * PluginKey identity from a renderer-direct y-prosemirror import, exactly
 * the surface this test scans.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Glob } from 'bun';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const RENDERER_ROOT = join(REPO_ROOT, 'packages/app/src');

/**
 * Static-import / require / dynamic-import patterns that bring `y-prosemirror`
 * into the renderer's module graph as a direct first-party dependency.
 *
 * - `from 'y-prosemirror'` and `from "y-prosemirror"` — ESM static import.
 *   Also covers `export { X } from 'y-prosemirror'` and `export *
 *   from 'y-prosemirror'` (the regex doesn't require an `import` prefix —
 *   `from <module>` is the load-bearing token in either form).
 * - `from 'y-prosemirror/...'` — ESM static import of a sub-path export.
 * - `require('y-prosemirror')` — CJS require (very rarely used in renderer
 *   but covered for completeness).
 * - `import('y-prosemirror')` — dynamic import (also rare in renderer; covered).
 * - `import 'y-prosemirror'` — bare side-effect import. y-prosemirror's
 *   module entry runs `new PluginKey('y-sync')` at module load, so a
 *   side-effect import (no binding) still triggers PluginKey creation and
 *   reintroduces the dual-stack identity-mismatch surface. The regex
 *   matches `import` followed by a string-literal module specifier with no
 *   intervening identifier or `{` brace. The dynamic-import form (with
 *   parens) is covered by its own pattern above.
 *
 * Bare-string mentions in comments / JSDoc / strings unrelated to imports
 * (e.g., a doc comment that says "y-prosemirror's binding") are NOT matched
 * because they don't bring the module into the graph.
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /from\s+['"]y-prosemirror['"]/g,
  /from\s+['"]y-prosemirror\/[^'"]+['"]/g,
  /require\(\s*['"]y-prosemirror['"]\s*\)/g,
  /import\(\s*['"]y-prosemirror['"]\s*\)/g,
  // Bare side-effect: `import 'y-prosemirror';` or `import "y-prosemirror";`
  // — `\bimport\s+` requires the `import` keyword followed by whitespace,
  // and the immediate string literal (not `(` for dynamic, not `{` or
  // identifier for binding form, not `type` for type-only — though
  // `import type 'y-prosemirror'` isn't valid TS syntax anyway).
  /\bimport\s+['"]y-prosemirror['"]/g,
];

function isExcludedPath(absPath: string): boolean {
  if (absPath.endsWith('.d.ts')) return true;
  if (absPath.includes('/node_modules/')) return true;
  if (absPath.includes('/dist/')) return true;
  return false;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

interface ScanResult {
  readonly violations: readonly Violation[];
  readonly filesScanned: number;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function scanRenderer(): ScanResult {
  const violations: Violation[] = [];
  let filesScanned = 0;
  const glob = new Glob('**/*.{ts,tsx}');
  for (const rel of glob.scanSync({ cwd: RENDERER_ROOT })) {
    const abs = join(RENDERER_ROOT, rel);
    if (isExcludedPath(abs)) continue;
    filesScanned++;
    const content = readFileSync(abs, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      // Reset regex lastIndex (matchAll on /g regex is consumed) — fresh per file.
      const matches = content.matchAll(new RegExp(pattern.source, pattern.flags));
      for (const m of matches) {
        violations.push({
          file: relative(REPO_ROOT, abs),
          line: lineOf(content, m.index ?? 0),
          match: m[0],
        });
      }
    }
  }
  return { violations, filesScanned };
}

// Anti-vacuousness floor for the scan. The renderer source tree contains
// hundreds of .ts/.tsx files; a count below this threshold means
// `RENDERER_ROOT` is wrong (path typo, directory rename), the glob pattern
// regressed, or the exclusion list grew too aggressive. Without this floor,
// `glob.scanSync` over an invalid cwd silently yields zero files and the
// violations array stays empty regardless of what's actually in the source.
const MIN_RENDERER_FILES = 50;

describe('renderer y-prosemirror import coverage', () => {
  test('scan covers a non-trivial number of renderer files (anti-vacuousness)', () => {
    const { filesScanned } = scanRenderer();
    expect(filesScanned).toBeGreaterThanOrEqual(MIN_RENDERER_FILES);
  });

  test('packages/app/src/**/*.{ts,tsx} contains no direct y-prosemirror imports', () => {
    const { violations } = scanRenderer();
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line} — ${v.match}`).join('\n');
      throw new Error(
        `Renderer imports from 'y-prosemirror' directly (single prosemirror-binding-stack invariant).\n` +
          `Migrate the import to '@tiptap/y-tiptap' (TipTap v3 official path; aligns with editor-cache.ts).\n` +
          `Rationale: each library ships its own \`new PluginKey('y-sync')\` at module load, so a renderer that imports from both ends up with two distinct PluginKey instances and silently breaks \`Y.UndoManager.trackedOrigins\` Set-by-identity matching.\n` +
          `Violations:\n${report}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
