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

  test('a diagnostic with no scope is excluded from both buckets', () => {
    const { missing, invalid } = partitionFrontmatterProblems([diag({})]);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  test('a non-frontmatter diagnostic is excluded from both buckets', () => {
    const { missing, invalid } = partitionFrontmatterProblems([
      diag({ source: 'markdownlint', code: 'MD010', message: 'Hard tabs' }),
    ]);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  test('two schemas requiring one property yield one missing entry', () => {
    const { missing } = partitionFrontmatterProblems([
      diag({ frontmatterScope: 'missing', frontmatterProperty: 'type', message: 'schema A' }),
      diag({ frontmatterScope: 'missing', frontmatterProperty: 'type', message: 'schema B' }),
    ]);
    expect(missing.map((d) => d.message)).toEqual(['schema A']);
  });

  test('distinct missing properties are each kept', () => {
    const { missing } = partitionFrontmatterProblems([
      diag({ frontmatterScope: 'missing', frontmatterProperty: 'type' }),
      diag({ frontmatterScope: 'missing', frontmatterProperty: 'status' }),
    ]);
    expect(missing.map((d) => d.frontmatterProperty)).toEqual(['type', 'status']);
  });

  test('invalid is not deduped by property', () => {
    const { invalid } = partitionFrontmatterProblems([
      diag({ frontmatterScope: 'invalid', frontmatterProperty: 'tags', message: 'must be array' }),
      diag({ frontmatterScope: 'invalid', frontmatterProperty: 'tags', message: 'too short' }),
    ]);
    expect(invalid.map((d) => d.message)).toEqual(['must be array', 'too short']);
  });

  test('two schemas stating one fault yield one invalid entry', () => {
    const { invalid } = partitionFrontmatterProblems([
      diag({
        frontmatterScope: 'invalid',
        source: 'okf',
        code: 'frontmatter-recommended',
        message: 'Frontmatter property "tags" must be array',
      }),
      diag({
        frontmatterScope: 'invalid',
        source: 'frontmatter',
        code: 'type',
        message: 'Frontmatter property "tags" must be array',
      }),
    ]);
    expect(invalid.map((d) => d.code)).toEqual(['frontmatter-recommended']);
  });

  test('unnamed missing findings are not collapsed into one', () => {
    const { missing } = partitionFrontmatterProblems([
      diag({ frontmatterScope: 'missing', message: 'a' }),
      diag({ frontmatterScope: 'missing', message: 'b' }),
    ]);
    expect(missing.map((d) => d.message)).toEqual(['a', 'b']);
  });

  test('an empty set yields two empty buckets', () => {
    const { missing, invalid } = partitionFrontmatterProblems([]);
    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
  });
});
