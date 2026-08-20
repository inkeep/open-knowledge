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

  test('a diagnostic with no scope is excluded from both buckets', () => {
    // No live producer emits a frontmatter diagnostic without scope — the
    // validator stamps `frontmatterScope` unconditionally — so a scope-less
    // diagnostic is a body finding, whatever its source. Routing it to either
    // bucket would inflate a frontmatter count with a problem neither
    // affordance can act on.
    const { missing, invalid } = partitionFrontmatterProblems([diag({})]);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  test('a non-frontmatter diagnostic is excluded from both buckets', () => {
    // A markdownlint (or any future third-plugin) body diagnostic carries no
    // frontmatterScope; if presence weren't the discriminator it would fall to
    // `invalid` and inflate the "N do not match the schema" count. The badge is
    // a frontmatter count, so scope-less findings belong in neither bucket.
    const { missing, invalid } = partitionFrontmatterProblems([
      diag({ source: 'markdownlint', code: 'MD010', message: 'Hard tabs' }),
    ]);
    expect(missing).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  test('two schemas requiring one property yield one missing entry', () => {
    // Every consumer of `missing` counts rows to add — the badge, the tooltip
    // that promises what a click will add, the panel that stages them — so a
    // per-diagnostic count would advertise two adds and perform one.
    const { missing } = partitionFrontmatterProblems([
      diag({ frontmatterScope: 'missing', frontmatterProperty: 'type', message: 'schema A' }),
      diag({ frontmatterScope: 'missing', frontmatterProperty: 'type', message: 'schema B' }),
    ]);
    // The first survives, so the tooltip still has a message to show.
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
    // Two schemas can fault one EXISTING row for different reasons, and the row
    // is already there to carry both — collapsing them would hide one.
    const { invalid } = partitionFrontmatterProblems([
      diag({ frontmatterScope: 'invalid', frontmatterProperty: 'tags', message: 'must be array' }),
      diag({ frontmatterScope: 'invalid', frontmatterProperty: 'tags', message: 'too short' }),
    ]);
    expect(invalid.map((d) => d.message)).toEqual(['must be array', 'too short']);
  });

  test('two schemas stating one fault yield one invalid entry', () => {
    // The `invalid` counterpart: when two schemas pin one property the same way
    // they restate the identical sentence, and this bucket's consumers count and
    // list sentences — so a per-diagnostic count would read 2 and show one
    // problem twice. Only the restatement collapses; the test above keeps two
    // different faults on one row apart.
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
    // The first survives, so the sentence the panel shows is unchanged.
    expect(invalid.map((d) => d.code)).toEqual(['frontmatter-recommended']);
  });

  test('unnamed missing findings are not collapsed into one', () => {
    // Nothing names a property to collapse on, so folding them together would
    // drop a distinct problem rather than a duplicate one.
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
