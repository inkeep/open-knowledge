
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Glob } from 'bun';

const PACKAGE_APP_ROOT = resolve(import.meta.dir, '../..');
const SCAN_ROOTS = ['src', 'tests'] as const;

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
    expect(domTests.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test('no non-dom *.test.tsx imports @testing-library/react (type-only imports exempt)', () => {
    const nonDomTsxTests = listTestTsxFiles().filter((p) => !p.endsWith('.dom.test.tsx'));
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
