import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const PACKAGE_APP_ROOT = resolve(import.meta.dir, '../..');
const SCAN_ROOTS = ['src', 'tests'] as const;

const VALUE_RTL_IMPORT_PATTERN =
  /\bimport\s+(?!type\s)[\s\S]*?from\s+['"]@testing-library\/react['"]|\bimport\s+['"]@testing-library\/react['"]/;
const RTL_TIER_SUFFIXES = ['.dom.test.tsx', '.browser.test.tsx'] as const;

interface TestSource {
  path: string;
  source: string;
}

function isRtlTierFile(path: string): boolean {
  return RTL_TIER_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function rtlImportsOutsideRtlTiers(files: readonly TestSource[]): string[] {
  return files
    .filter((file) => !isRtlTierFile(file.path) && VALUE_RTL_IMPORT_PATTERN.test(file.source))
    .map((file) => file.path);
}

function rtlImportViolationMessage(violations: readonly string[]): string {
  return `Tier-3 filename contract violation — *.test.tsx (non-dom) files MUST NOT import a value from @testing-library/react:\n${violations
    .map((p) => `  - ${p}`)
    .join(
      '\n',
    )}\n\nFix: rename to *.dom.test.tsx (NG6 escape hatch — per-file migration allowed when the file is a natural Tier-3 candidate), or to *.browser.test.tsx when it belongs in the production-compiled browser tier, OR remove the @testing-library/react value import. Type-only imports (\`import type { X } from '@testing-library/react'\`) are exempt — they erase at compile time and don't trigger module evaluation.`;
}

const PLANTED_RTL_IMPORT = "import { render, screen } from '@testing-library/react';";

function listTestTsxFiles(): string[] {
  const results: string[] = [];
  for (const root of SCAN_ROOTS) {
    const rootAbsolute = resolve(PACKAGE_APP_ROOT, root);
    for (const path of new Bun.Glob('**/*.test.tsx').scanSync({
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

  test('no *.test.tsx outside the dom and browser tiers imports @testing-library/react (type-only imports exempt)', () => {
    const outsideRtlTiers = listTestTsxFiles().filter((p) => !isRtlTierFile(p));
    expect(outsideRtlTiers.length).toBeGreaterThan(0);
    const violations = rtlImportsOutsideRtlTiers(
      outsideRtlTiers.map((path) => ({ path, source: readFileSync(path, 'utf-8') })),
    );
    if (violations.length > 0) {
      throw new Error(rtlImportViolationMessage(violations));
    }
    expect(violations).toEqual([]);
  });

  test('a value import of @testing-library/react in a Node-tier *.test.tsx is reported', () => {
    const violations = rtlImportsOutsideRtlTiers([
      { path: 'src/components/Planted.test.tsx', source: PLANTED_RTL_IMPORT },
    ]);

    expect(violations).toEqual(['src/components/Planted.test.tsx']);
    expect(rtlImportViolationMessage(violations)).toMatch(
      /^Tier-3 filename contract violation — \*\.test\.tsx \(non-dom\) files MUST NOT import a value from @testing-library\/react:\n {2}- src\/components\/Planted\.test\.tsx\n\nFix: /,
    );
  });

  test('a *.browser.test.tsx importing @testing-library/react is admitted beside the dom tier and type-only imports', () => {
    const violations = rtlImportsOutsideRtlTiers([
      { path: 'tests/foundation/planted.browser.test.tsx', source: PLANTED_RTL_IMPORT },
      { path: 'src/components/Planted.dom.test.tsx', source: PLANTED_RTL_IMPORT },
      {
        path: 'src/components/TypeOnly.test.tsx',
        source: "import type { RenderResult } from '@testing-library/react';",
      },
      { path: 'src/components/Planted.test.tsx', source: PLANTED_RTL_IMPORT },
    ]);

    expect(violations).toEqual(['src/components/Planted.test.tsx']);
  });
});
