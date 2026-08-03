/**
 * The missing/invalid split decides which affordance reports a frontmatter
 * problem, so it has to hold for the cases the validator can actually produce —
 * including the one `code === 'required'` alone gets wrong.
 */

import type { LintDiagnostic } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { partitionFrontmatterProblems } from './useFrontmatterDiagnostics.ts';

function diag(over: Partial<LintDiagnostic>): LintDiagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 'warning',
    source: 'frontmatter',
    code: 'required',
    message: 'Frontmatter property "status" is required',
    ...over,
  };
}

describe('partitionFrontmatterProblems', () => {
  test('routes an absent top-level property to missing', () => {
    const { missing, invalid } = partitionFrontmatterProblems([
      diag({ frontmatterScope: 'missing' }),
    ]);
    expect(missing).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });

  test('routes a present-but-wrong property to invalid', () => {
    const { missing, invalid } = partitionFrontmatterProblems([
      diag({ code: 'enum', frontmatterScope: 'invalid' }),
    ]);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(1);
  });

  test('a nested `required` is invalid, not missing', () => {
    // The property exists; a key INSIDE it is absent. Routing this to the
    // Add-properties button would tell the user to add something already there.
    const { missing, invalid } = partitionFrontmatterProblems([
      diag({
        code: 'required',
        frontmatterScope: 'invalid',
        message: 'Frontmatter property "author.email" is required',
      }),
    ]);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(1);
  });

  test('splits a mixed set and preserves order within each bucket', () => {
    const { missing, invalid } = partitionFrontmatterProblems([
      diag({ frontmatterScope: 'missing', message: 'a' }),
      diag({ frontmatterScope: 'invalid', message: 'b' }),
      diag({ frontmatterScope: 'missing', message: 'c' }),
    ]);
    expect(missing.map((d) => d.message)).toEqual(['a', 'c']);
    expect(invalid.map((d) => d.message)).toEqual(['b']);
  });

  test('a diagnostic with no scope falls to invalid', () => {
    // Predates the field. Invalid keeps it on the panel rather than inviting an
    // add for a property that may already exist.
    const { missing, invalid } = partitionFrontmatterProblems([diag({})]);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(1);
  });

  test('a non-frontmatter diagnostic is excluded from both buckets', () => {
    // A markdownlint (or any future third-plugin) diagnostic carries no
    // frontmatterScope; without a source guard it would fall to `invalid` and
    // inflate the "N do not match the schema" count. The badge is a frontmatter
    // count, so non-frontmatter sources belong in neither bucket.
    const { missing, invalid } = partitionFrontmatterProblems([
      diag({ source: 'markdownlint', code: 'MD010', message: 'Hard tabs' }),
    ]);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  test('an empty set yields two empty buckets', () => {
    const { missing, invalid } = partitionFrontmatterProblems([]);
    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
  });
});
