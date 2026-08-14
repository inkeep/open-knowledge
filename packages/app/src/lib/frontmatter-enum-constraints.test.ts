import type { LinterConfig, OkfRuleId } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { enumConstraintsForDoc } from './frontmatter-enum-constraints.ts';

function configWith(
  schemas: {
    appliesTo?: string | string[];
    file: string;
    key?: string;
    enabled?: boolean;
    schema?: Record<string, unknown>;
  }[],
  enabled = true,
): LinterConfig {
  return {
    enabled: true,
    plugins: {
      markdownlint: { enabled: false, rules: {} },
      frontmatter: { enabled, schemas },
    },
  };
}

const DOC_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['draft', 'review', 'published'] },
    tags: { type: 'array', items: { enum: ['a', 'b'] } },
    owner: { type: 'string' },
  },
};

/**
 * The OKF profile is a second source of governing schemas, carrying no files and
 * gated on its own plugin. These exercise the REAL built-in schemas rather than a
 * stand-in, so a change to the shipped `status` vocabulary fails here.
 */
function configWithOkf(
  okf: { enabled: boolean; rules?: Partial<Record<OkfRuleId, boolean>> },
  frontmatter: { enabled: boolean; schemas: Parameters<typeof configWith>[0] } = {
    enabled: false,
    schemas: [],
  },
): LinterConfig {
  return {
    enabled: true,
    plugins: {
      markdownlint: { enabled: false, rules: {} },
      frontmatter,
      okf,
    },
  } as LinterConfig;
}

describe('enumConstraintsForDoc — the OKF profile', () => {
  test('OKF alone supplies the status vocabulary, with the frontmatter plugin off', () => {
    const constraints = enumConstraintsForDoc(configWithOkf({ enabled: true }), 'notes/concept');
    expect(constraints.get('status')).toEqual({
      values: ['draft', 'stable', 'deprecated'],
      multi: false,
    });
  });

  test('with OKF off it supplies nothing', () => {
    expect(enumConstraintsForDoc(configWithOkf({ enabled: false }), 'notes/concept').size).toBe(0);
  });

  test('a disabled rule withdraws its schema from the vocabulary', () => {
    const constraints = enumConstraintsForDoc(
      configWithOkf({ enabled: true, rules: { 'frontmatter-provenance': false } }),
      'notes/concept',
    );
    expect(constraints.has('status')).toBe(false);
  });

  test('the two sources intersect rather than one winning', () => {
    // The project's own schema offers draft/review/published; OKF offers
    // draft/stable/deprecated. Only `draft` satisfies both, and the panel must
    // offer only what validates against every governing schema.
    const constraints = enumConstraintsForDoc(
      configWithOkf(
        { enabled: true },
        { enabled: true, schemas: [{ file: 'a.json', schema: DOC_SCHEMA }] },
      ),
      'notes/concept',
    );
    expect(constraints.get('status')).toEqual({ values: ['draft'], multi: false });
  });

  test('scoping is honored — a nested index is governed by a schema with no vocabularies', () => {
    expect(enumConstraintsForDoc(configWithOkf({ enabled: true }), 'notes/index').size).toBe(0);
  });
});

describe('enumConstraintsForDoc', () => {
  test('enum fields map to single-select; array items.enum to multi', () => {
    const constraints = enumConstraintsForDoc(
      configWith([{ appliesTo: 'docs/**', file: 'd.json', schema: DOC_SCHEMA }]),
      'docs/guide',
    );
    expect(constraints.get('status')).toEqual({
      values: ['draft', 'review', 'published'],
      multi: false,
    });
    expect(constraints.get('tags')).toEqual({ values: ['a', 'b'], multi: true });
    expect(constraints.has('owner')).toBe(false);
  });

  test('a non-matching doc, a disabled plugin, and no doc identity all yield nothing', () => {
    const config = configWith([{ appliesTo: 'docs/**', file: 'd.json', schema: DOC_SCHEMA }]);
    expect(enumConstraintsForDoc(config, 'specs/other').size).toBe(0);
    expect(enumConstraintsForDoc(configWith([], false), 'docs/guide').size).toBe(0);
    expect(enumConstraintsForDoc(config, undefined).size).toBe(0);
    expect(enumConstraintsForDoc(null, 'docs/guide').size).toBe(0);
  });

  test('a toggled-off mapping constrains nothing, matching the lint plugin', () => {
    const constraints = enumConstraintsForDoc(
      configWith([{ appliesTo: 'docs/**', file: 'd.json', enabled: false, schema: DOC_SCHEMA }]),
      'docs/guide',
    );
    expect(constraints.size).toBe(0);
  });

  test('conjunction intersects vocabularies across matching schemas', () => {
    const constraints = enumConstraintsForDoc(
      configWith([
        {
          file: 'a.json',
          key: 'A',
          schema: { properties: { status: { enum: ['draft', 'review', 'published'] } } },
        },
        {
          file: 'b.json',
          key: 'B',
          schema: { properties: { status: { enum: ['review', 'published', 'archived'] } } },
        },
      ]),
      'docs/guide',
    );
    expect(constraints.get('status')).toEqual({ values: ['review', 'published'], multi: false });
  });

  test('an empty intersection drops to free text', () => {
    const constraints = enumConstraintsForDoc(
      configWith([
        { file: 'a.json', key: 'A', schema: { properties: { status: { enum: ['x'] } } } },
        { file: 'b.json', key: 'B', schema: { properties: { status: { enum: ['y'] } } } },
      ]),
      'docs/guide',
    );
    expect(constraints.has('status')).toBe(false);
  });

  test('mismatched multi-ness across schemas drops to free text', () => {
    // Vocabularies are deliberately identical, so only the multi-ness guard can
    // cause the drop — a scalar enum and an array items.enum cannot both be
    // satisfied by one widget, and picking either would misrepresent a schema.
    const single = { properties: { tags: { enum: ['x', 'y'] } } };
    const multi = { properties: { tags: { type: 'array', items: { enum: ['x', 'y'] } } } };
    expect(
      enumConstraintsForDoc(
        configWith([
          { file: 'a.json', key: 'A', schema: single },
          { file: 'b.json', key: 'B', schema: multi },
        ]),
        'docs/guide',
      ).has('tags'),
    ).toBe(false);
    // Order-independent: whichever is seen first must not decide the shape.
    expect(
      enumConstraintsForDoc(
        configWith([
          { file: 'b.json', key: 'B', schema: multi },
          { file: 'a.json', key: 'A', schema: single },
        ]),
        'docs/guide',
      ).has('tags'),
    ).toBe(false);
  });

  test('three schemas narrow progressively to the running intersection', () => {
    // A∩B∩C is non-empty, so the field keeps a vocabulary. Folding against the
    // ORIGINAL values instead of the running intersection would leave 'b' in.
    const a = { properties: { status: { enum: ['a', 'b', 'c'] } } };
    const b = { properties: { status: { enum: ['a', 'b'] } } };
    const c = { properties: { status: { enum: ['a', 'c'] } } };
    const constraints = enumConstraintsForDoc(
      configWith([
        { file: 'a.json', key: 'A', schema: a },
        { file: 'b.json', key: 'B', schema: b },
        { file: 'c.json', key: 'C', schema: c },
      ]),
      'docs/guide',
    );
    expect(constraints.get('status')).toEqual({ values: ['a'], multi: false });
  });

  test('a conflict is terminal — a later schema cannot resurrect a vocabulary', () => {
    // A offers [x,y] as a single-select, B is multi (mismatch, drops to free
    // text), then C offers [z]. If the drop is not terminal, C re-enters the
    // "no existing constraint" branch and the panel offers [z] — a value A
    // forbids, which is exactly the guarantee this module makes.
    const single = { properties: { tags: { enum: ['x', 'y'] } } };
    const multi = { properties: { tags: { type: 'array', items: { enum: ['x', 'y'] } } } };
    const other = { properties: { tags: { enum: ['z'] } } };
    expect(
      enumConstraintsForDoc(
        configWith([
          { file: 'a.json', key: 'A', schema: single },
          { file: 'b.json', key: 'B', schema: multi },
          { file: 'c.json', key: 'C', schema: other },
        ]),
        'docs/guide',
      ).has('tags'),
    ).toBe(false);
  });

  test('an empty intersection is terminal too', () => {
    const x = { properties: { status: { enum: ['x'] } } };
    const y = { properties: { status: { enum: ['y'] } } };
    const z = { properties: { status: { enum: ['z'] } } };
    expect(
      enumConstraintsForDoc(
        configWith([
          { file: 'a.json', key: 'A', schema: x },
          { file: 'b.json', key: 'B', schema: y },
          { file: 'c.json', key: 'C', schema: z },
        ]),
        'docs/guide',
      ).has('status'),
    ).toBe(false);
  });

  test('duplicate entries for one file (same key) count once', () => {
    const constraints = enumConstraintsForDoc(
      configWith([
        { appliesTo: '**', file: 'd.json', key: 'K', schema: DOC_SCHEMA },
        { appliesTo: 'docs/**', file: './d.json', key: 'K', schema: DOC_SCHEMA },
      ]),
      'docs/guide',
    );
    expect(constraints.get('status')?.values).toEqual(['draft', 'review', 'published']);
  });
});
