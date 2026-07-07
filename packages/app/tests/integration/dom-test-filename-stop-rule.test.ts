/**
 * STOP-rule for the Tier-3 filename contract.
 *
 * The Tier-3 React-runtime test substrate routes invocations via the
 * `*.dom.test.tsx` filename suffix: the `bun run test:dom` script and the
 * scoped jsdom preload chain only attach for these files. To keep the
 * routing signal load-bearing, two filename-content invariants must hold
 * across all `*.test.tsx` files under `packages/app/` (both `src/**`
 * co-located adopters AND `tests/**` integration / e2e files):
 *
 *   1. Every `*.dom.test.tsx` file MUST import a value from
 *      `@testing-library/react` — the test is a Tier-3 mount test by
 *      definition, and any file with this name that fails to import RTL
 *      is a stale/wrong-named artifact.
 *
 *   2. No `*.test.tsx` file (without the `.dom.` segment) MAY import a
 *      value from `@testing-library/react` — non-Tier-3 `.tsx` test files
 *      use `renderToString` from `react-dom/server`, JSX fixture builders,
 *      or source-grep; importing RTL from one would route execution
 *      through a non-jsdom substrate and crash on first DOM access.
 *
 * **Type-only imports are exempt** from both invariants. `import type { X }
 * from '@testing-library/react'` is erased at compile time and never
 * triggers module evaluation, so it doesn't actually attach the runtime
 * substrate. A non-dom fixture that reuses an RTL type via `import type`
 * is fine. The regex distinguishes value imports from type imports.
 *
 * On failure, the message points at the file and explains the two ways to
 * resolve: (a) rename to `.dom.test.tsx` (escape hatch — a per-file
 * migration is allowed when the file is a natural Tier-3 candidate), OR
 * (b) remove the RTL value import (keeping `import type` is fine).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Glob } from 'bun';

const PACKAGE_APP_ROOT = resolve(import.meta.dir, '../..');
const SCAN_ROOTS = ['src', 'tests'] as const;

// Match a *value* import from @testing-library/react. Negative lookahead
// excludes `import type` (compile-time erasure — no runtime substrate
// attach). `(?!type\s)` after `import` is the precise filter; we also
// accept bare side-effect imports (`import '@testing-library/react'`)
// which DO trigger module evaluation.
const VALUE_RTL_IMPORT_PATTERN =
  /\bimport\s+(?!type\s)[\s\S]*?from\s+['"]@testing-library\/react['"]|\bimport\s+['"]@testing-library\/react['"]/;

function listTestTsxFiles(): string[] {
  const results: string[] = [];
  for (const root of SCAN_ROOTS) {
    const rootAbsolute = resolve(PACKAGE_APP_ROOT, root);
    for (const path of new Glob('**/*.test.tsx').scanSync({
      cwd: rootAbsolute,
      absolute: true,
    })) {
      results.push(path);
    }
  }
  return results;
}

describe('Tier-3 filename contract — *.dom.test.tsx ↔ @testing-library/react', () => {
  test('every *.dom.test.tsx imports @testing-library/react', () => {
    const allTsxTests = listTestTsxFiles();
    const domTests = allTsxTests.filter((p) => p.endsWith('.dom.test.tsx'));
    const violations = domTests.filter((path) => {
      const src = readFileSync(path, 'utf-8');
      return !VALUE_RTL_IMPORT_PATTERN.test(src);
    });
    if (violations.length > 0) {
      throw new Error(
        `Tier-3 filename contract violation — every *.dom.test.tsx file must import @testing-library/react:\n${violations
          .map((p) => `  - ${p}: missing import`)
          .join(
            '\n',
          )}\n\nFix: add \`import { render } from '@testing-library/react';\` OR rename the file if it is not Tier-3.`,
      );
    }
    // Sanity floor: assert we actually scanned at least one *.dom.test.tsx
    // file. Without this, an empty glob (e.g. via a scope refactor that
    // breaks SCAN_ROOTS) would make the test trivially pass forever.
    expect(domTests.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test('no non-dom *.test.tsx imports @testing-library/react (type-only imports exempt)', () => {
    const nonDomTsxTests = listTestTsxFiles().filter((p) => !p.endsWith('.dom.test.tsx'));
    // Sanity floor (symmetric with the positive test): assert we
    // actually scanned at least one non-dom *.test.tsx file. Without this,
    // a future scope refactor that empties the non-dom pool would make this
    // negative assertion trivially pass forever.
    expect(nonDomTsxTests.length).toBeGreaterThan(0);
    const violations = nonDomTsxTests.filter((path) => {
      const src = readFileSync(path, 'utf-8');
      return VALUE_RTL_IMPORT_PATTERN.test(src);
    });
    if (violations.length > 0) {
      throw new Error(
        `Tier-3 filename contract violation — *.test.tsx (non-dom) files MUST NOT import a value from @testing-library/react:\n${violations
          .map((p) => `  - ${p}`)
          .join(
            '\n',
          )}\n\nFix: rename to *.dom.test.tsx (NG6 escape hatch — per-file migration allowed when the file is a natural Tier-3 candidate), OR remove the @testing-library/react value import. Type-only imports (\`import type { X } from '@testing-library/react'\`) are exempt — they erase at compile time and don't trigger module evaluation.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
