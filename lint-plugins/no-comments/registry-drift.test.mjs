import { describe, expect, test } from 'vitest';
import {
  DIRECTIVE_PATTERNS,
  DIRECTIVE_REGISTRY_KEYS,
  GUARD_MARKERS,
  UPSTREAM_REFERENT_SHAPES,
  directivesFor,
} from './allowlist.mjs';
import {
  documentedRegistryRows,
  documentedViolationClasses,
  emittedViolationClasses,
} from './documented-classes.test-helper.mjs';

const firstCells = (heading) => documentedRegistryRows(heading).map((row) => row[0]);

describe('the README is the registry, not a summary of it', () => {
  test('it tabulates every directive the predicate admits, and no other', () => {
    expect(firstCells('Tool-parsed directives')).toStrictEqual(
      DIRECTIVE_PATTERNS.map((directive) => directive.id),
    );
  });

  test('each directive row shows shapes the predicate declares for that id', () => {
    const documented = new Map(
      documentedRegistryRows('Tool-parsed directives').map((row) => [row[0], row.slice(1)]),
    );
    const wrong = DIRECTIVE_PATTERNS.flatMap((directive) =>
      (documented.get(directive.id) ?? [])
        .filter((shape) => !directive.shapes.includes(shape))
        .map((shape) => `${directive.id}: ${shape}`),
    );
    expect(wrong).toStrictEqual([]);
  });

  test('every declared shape reaches a reader, so no row hides one', () => {
    const documented = new Map(
      documentedRegistryRows('Tool-parsed directives').map((row) => [row[0], row.slice(1)]),
    );
    const undocumented = DIRECTIVE_PATTERNS.flatMap((directive) =>
      directive.shapes
        .filter((shape) => !(documented.get(directive.id) ?? []).includes(shape))
        .map((shape) => `${directive.id}: ${shape}`),
    );
    expect(undocumented).toStrictEqual([]);
  });

  test('it tabulates every guard marker the predicate registers, and no other', () => {
    expect(firstCells('Guard-defined metacomment markers')).toStrictEqual(
      GUARD_MARKERS.map((marker) => marker.id),
    );
  });

  test('it tabulates every upstream referent shape the predicate accepts, and no other', () => {
    expect(firstCells('Contract markers')).toStrictEqual(
      UPSTREAM_REFERENT_SHAPES.map((shape) => shape.id),
    );
  });

  test('it tabulates every family and file class the predicate answers for, and no other', () => {
    const documented = documentedRegistryRows('Which directives a file class admits').map(
      (row) => `${row[0]}/${row[1]}`,
    );
    expect(documented).toStrictEqual(
      DIRECTIVE_REGISTRY_KEYS.map(({ extractor, fileClass }) => `${extractor}/${fileClass}`),
    );
  });

  test('it heads a section for every violation class the source names, and no other', () => {
    const emitted = emittedViolationClasses();
    expect(emitted.length).toBeGreaterThan(0);
    expect([...documentedViolationClasses()].sort()).toStrictEqual([...emitted].sort());
  });

  test('a file class the README calls empty admits nothing, and one it points at the table admits it', () => {
    const admits = (extractor, fileClass) => directivesFor(extractor, fileClass).length;
    expect(admits('hash-family', 'shell')).toBe(0);
    expect(admits('c-family', 'typescript')).toBe(DIRECTIVE_PATTERNS.length);
  });
});
