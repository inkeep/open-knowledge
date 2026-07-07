/**
 * Meta-test: every `data-component-type="<name>"` literal in test files must
 * reference either a registered JSX descriptor (lowercased canonical name) or
 * a production-side substrate name on the explicit exception list.
 *
 * Catches the silent-drift bug class that left fixtures pointing at
 * `data-component-type="cards"` / `"steps"` / `"card"` (substrate names that
 * never existed in OK's reduced 5-pack registry) for months — the `cards` /
 * `steps` / `card` rules in CSS + production were swept out, but the test
 * fixtures weren't, and the only signal was `selection-indicator.e2e.ts`
 * timing out indefinitely on `waitForSelector`. Without this guard, the next
 * substrate rename has the same blast radius.
 *
 * Test-author affordance: when a fixture intentionally references a name
 * that is NOT in the descriptor registry (e.g., a production-side renderer
 * sets a non-descriptor substrate-type string for DOM-level convenience),
 * add the lowercased name to `TEST_FIXTURE_KNOWN_NONREGISTERED` below with
 * a per-entry comment explaining intent. The list is bounded by review.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, type Stats, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getRegisteredDescriptors } from '../../src/editor/registry/index.ts';

// Resolve paths against this file's location, not cwd. Matches the
// established convention in `tests/integration/*-coverage.test.ts` so the
// test stays correct under any caller's cwd (IDE test runner, future CI
// changes, scoped `bun test <path>` invocations).
const APP_ROOT = resolve(import.meta.dirname, '../..');
const PACKAGES_ROOT = resolve(APP_ROOT, '..');
// Scan every sibling package's source + test trees so a future
// `data-component-type="<x>"` reference in `packages/core/**`,
// `packages/server/**`, `packages/desktop/**`, `packages/cli/**`,
// `packages/plugin/**`, etc. is also covered. The precedent #47 promise is
// "every test reference must resolve" — not "every test reference in
// packages/app". Filtered to existing dirs via statSync inside the scan.
const ROOTS = [
  join(APP_ROOT, 'src'),
  join(APP_ROOT, 'tests'),
  ...['core', 'server', 'cli', 'desktop', 'plugin'].flatMap((pkg) => [
    join(PACKAGES_ROOT, pkg, 'src'),
    join(PACKAGES_ROOT, pkg, 'tests'),
  ]),
];
const SELF_FILE = resolve(import.meta.dirname, 'substrate-vocabulary-drift.test.ts');

/** Substrate names that legitimately appear in test fixtures despite NOT
 *  being JSX descriptor names. Each entry MUST carry a comment naming the
 *  production renderer / source that emits it. */
const TEST_FIXTURE_KNOWN_NONREGISTERED: Record<string, string> = {
  // Mermaid.tsx renders the `MermaidFence` compat descriptor with
  // `data-component-type="mermaid"` for DOM-side CSS targeting. The
  // descriptor name `MermaidFence` and the DOM substrate-type string
  // `mermaid` are intentionally different.
  mermaid:
    'Mermaid.tsx — renders MermaidFence compat with substrate-type="mermaid" for DOM targeting',
};

/** Walk `dir` recursively, returning every file ending in `.test.ts` /
 *  `.test.tsx` / `.e2e.ts` (the file extensions the project's testing
 *  conventions use). */
function* walkTestFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip generated / build dirs.
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walkTestFiles(full);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.test.tsx') ||
        entry.name.endsWith('.e2e.ts'))
    ) {
      yield full;
    }
  }
}

/** Match `data-component-type="<name>"` OR `data-component-type='<name>'`
 *  where `<name>` is a literal string with no `${...}` template-literal
 *  interpolation. Both quote forms appear in OK's codebase: double-quoted
 *  attribute literals in JSX / TSX, single-quoted CSS selector forms in
 *  Playwright string selectors (`page.locator('[data-component-type=\'x\']')`).
 *  Capture group 1 holds the double-quoted body, group 2 the single-quoted
 *  body — `match[1] ?? match[2]` resolves the value side-agnostic. The
 *  character class excludes the matching quote, the cross-quote (so we don't
 *  accidentally span a closing-then-opening pair), AND `$` (the template-literal
 *  introducer), so interpolated forms are intentionally NOT captured. The
 *  `...` ellipsis form is filtered post-match. */
const COMPONENT_TYPE_LITERAL = /data-component-type="([^"'$]+)"|data-component-type='([^"'$]+)'/g;

describe('substrate vocabulary drift — every test reference must resolve', () => {
  test('every `data-component-type="<name>"` literal is a registered descriptor or a known exception', () => {
    // Build authoritative set: lowercased registered descriptor names +
    // wildcard. Compat descriptors are included because they have their own
    // `.name` field and tests may reference them by their lowercased form.
    const registered = new Set<string>();
    for (const d of getRegisteredDescriptors()) {
      registered.add(d.name.toLowerCase());
    }
    registered.add('*'); // wildcard is excluded from getRegisteredDescriptors

    // Roots to scan: collocated unit tests under src + the tests/ tree.
    // Paths resolved via `import.meta.dirname` so the test runs correctly
    // regardless of caller cwd (see module-scope ROOTS / SELF_FILE).
    const violations: Array<{ file: string; line: number; name: string }> = [];

    for (const root of ROOTS) {
      let rootStat: Stats;
      try {
        rootStat = statSync(root);
      } catch {
        continue;
      }
      if (!rootStat.isDirectory()) continue;

      for (const file of walkTestFiles(root)) {
        if (file === SELF_FILE) continue;
        const content = readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          COMPONENT_TYPE_LITERAL.lastIndex = 0;
          let match: RegExpExecArray | null = COMPONENT_TYPE_LITERAL.exec(line);
          while (match !== null) {
            // Group 1: double-quoted body. Group 2: single-quoted body.
            // Exactly one is set per match by the alternation.
            const name = match[1] ?? match[2];
            if (name && name !== '...') {
              const lower = name.toLowerCase();
              if (!registered.has(lower) && !(lower in TEST_FIXTURE_KNOWN_NONREGISTERED)) {
                violations.push({ file, line: i + 1, name: lower });
              }
            }
            match = COMPONENT_TYPE_LITERAL.exec(line);
          }
        }
      }
    }

    if (violations.length > 0) {
      const lines = violations.map(
        (v) =>
          `  - ${v.file}:${v.line} references data-component-type="${v.name}" — not registered. ` +
          `Resolution: (a) update the test reference to a registered substrate name; ` +
          `(b) add "${v.name}" to TEST_FIXTURE_KNOWN_NONREGISTERED in ` +
          `tests/meta/substrate-vocabulary-drift.test.ts with a comment naming the production source.`,
      );
      throw new Error(
        `Substrate-vocabulary drift detected (${violations.length} reference${
          violations.length === 1 ? '' : 's'
        }):\n${lines.join('\n')}`,
      );
    }

    // Trivially satisfy bun:test's expect-call gate.
    expect(violations).toHaveLength(0);
  });
});
