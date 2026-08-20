import type { LinterConfig } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { schemaFieldsForDoc } from './frontmatter-schema-fields.ts';

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
  required: ['status'],
  properties: {
    status: { type: 'string', description: 'Lifecycle stage' },
    tags: { type: 'array', items: { type: 'string' } },
    reviewedAt: { type: 'string', format: 'date' },
    weight: { type: 'number' },
    ordinal: { type: 'integer' },
    draft: { type: 'boolean' },
    author: { type: 'object' },
    freeform: {},
  },
};

function fieldsFor(schema: Record<string, unknown>, docName = 'docs/guide') {
  return schemaFieldsForDoc(
    configWith([{ appliesTo: 'docs/**', file: 'd.json', schema }]),
    docName,
  );
}

/** The fields `schemas` declare for `docs/guide`, all governing it in this order. */
function fieldsForOrder(schemas: Record<string, unknown>[]) {
  return schemaFieldsForDoc(
    configWith(
      schemas.map((schema, index) => ({
        appliesTo: 'docs/**',
        file: `${index}.json`,
        schema,
      })),
    ),
    'docs/guide',
  );
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

const WEIGHT_UNTYPED = { type: 'object', properties: { weight: { description: 'How heavy' } } };
const WEIGHT_NUMBER = { type: 'object', properties: { weight: { type: 'number' } } };
const WEIGHT_DATE = {
  type: 'object',
  properties: { weight: { type: 'string', format: 'date' } },
};
const WEIGHT_ARRAY = { type: 'object', properties: { weight: { type: 'array' } } };
const WEIGHT_REQUIRED_ONLY = { type: 'object', required: ['weight'] };

describe('schemaFieldsForDoc', () => {
  test('each JSON-Schema type maps to its widget type', () => {
    const fields = fieldsFor(DOC_SCHEMA);
    expect(fields.get('status')?.type).toBe('text');
    expect(fields.get('tags')?.type).toBe('list');
    expect(fields.get('reviewedAt')?.type).toBe('date');
    expect(fields.get('weight')?.type).toBe('number');
    expect(fields.get('ordinal')?.type).toBe('number');
    expect(fields.get('draft')?.type).toBe('boolean');
    expect(fields.get('author')?.type).toBe('object');
  });

  test('an undeclared type falls back to text', () => {
    expect(fieldsFor(DOC_SCHEMA).get('freeform')?.type).toBe('text');
  });

  test('a union type falls back to text rather than guessing a branch', () => {
    const fields = fieldsFor({
      type: 'object',
      properties: { either: { type: ['string', 'number'] } },
    });
    expect(fields.get('either')?.type).toBe('text');
  });

  test('an unknown type name falls back to text', () => {
    const fields = fieldsFor({ type: 'object', properties: { odd: { type: 'null' } } });
    expect(fields.get('odd')?.type).toBe('text');
  });

  test('an array of non-scalars is not offered at all', () => {
    // The list widget writes a flat array of scalars, so a row committed for
    // this field is faulted by the same schema that suggested it.
    const fields = fieldsFor({
      type: 'object',
      properties: {
        entries: { type: 'array', items: { type: 'object', required: ['resource'] } },
        nested: { type: 'array', items: { type: 'array' } },
      },
    });
    expect(fields.has('entries')).toBe(false);
    expect(fields.has('nested')).toBe(false);
  });

  test('an array that leaves its items open is still offered', () => {
    // Nothing was stated about the items, so a scalar list violates nothing.
    expect(
      fieldsFor({ type: 'object', properties: { any: { type: 'array' } } }).get('any')?.type,
    ).toBe('list');
  });

  test('a property constrained only by a composition keyword is not offered', () => {
    // No top-level type, so it would fall to the free-text widget, which cannot
    // express either accepted shape.
    const fields = fieldsFor({
      type: 'object',
      properties: {
        either: { anyOf: [{ type: 'object' }, { type: 'array' }] },
        exactly: { oneOf: [{ type: 'object' }] },
        both: { allOf: [{ type: 'object' }] },
        neither: { not: { type: 'string' } },
      },
    });
    for (const name of ['either', 'exactly', 'both', 'neither']) {
      expect(fields.has(name)).toBe(false);
    }
  });

  test('an enum with no declared type is still offered', () => {
    // The vocabulary layer offers its values and free text accepts them, so
    // there is nothing here a committed row can violate.
    const fields = fieldsFor({
      type: 'object',
      properties: { state: { enum: ['draft', 'stable'] } },
    });
    expect(fields.get('state')?.type).toBe('text');
  });

  test('a required field with no authorable widget stays offered', () => {
    // The missing-property diagnostic stages a row for it regardless, so
    // withdrawing it from the picker would hide the name and change nothing.
    const fields = fieldsFor({
      type: 'object',
      required: ['entries'],
      properties: { entries: { type: 'array', items: { type: 'object' } } },
    });
    expect(fields.get('entries')).toEqual({ type: 'text', required: true });
  });

  test('a required field with no authorable widget keeps its description', () => {
    // It is offered either way, and it is the field the user has least choice
    // about, so the schema's own hint is the one thing that must survive the
    // widget being withheld.
    const fields = fieldsFor({
      type: 'object',
      required: ['entries'],
      properties: {
        entries: {
          type: 'array',
          items: { type: 'object' },
          description: 'One record per upstream source',
        },
      },
    });
    expect(fields.get('entries')).toEqual({
      type: 'text',
      required: true,
      description: 'One record per upstream source',
    });
  });

  test('required and description ride along', () => {
    const fields = fieldsFor(DOC_SCHEMA);
    expect(fields.get('status')).toEqual({
      type: 'text',
      required: true,
      description: 'Lifecycle stage',
    });
    expect(fields.get('tags')?.required).toBe(false);
    expect(fields.get('tags')?.description).toBeUndefined();
  });

  test('a field required but never declared is still offered, as text', () => {
    const fields = fieldsFor({ type: 'object', required: ['ghost'], properties: {} });
    expect(fields.get('ghost')).toEqual({ type: 'text', required: true });
  });

  test('conflicting types across two governing schemas degrade to text', () => {
    const fields = schemaFieldsForDoc(
      configWith([
        {
          appliesTo: 'docs/**',
          file: 'a.json',
          schema: { type: 'object', properties: { size: { type: 'number' } } },
        },
        {
          appliesTo: 'docs/**',
          file: 'b.json',
          schema: { type: 'object', properties: { size: { type: 'array' } } },
        },
      ]),
      'docs/guide',
    );
    expect(fields.get('size')?.type).toBe('text');
  });

  test('a conflict stays dropped when a third schema re-declares the first type', () => {
    // Without the terminal drop set, the third schema would agree with the
    // `text` fallback and the offered widget would depend on schema order.
    const fields = schemaFieldsForDoc(
      configWith([
        {
          appliesTo: 'docs/**',
          file: 'a.json',
          schema: { type: 'object', properties: { size: { type: 'number' } } },
        },
        {
          appliesTo: 'docs/**',
          file: 'b.json',
          schema: { type: 'object', properties: { size: { type: 'array' } } },
        },
        {
          appliesTo: 'docs/**',
          file: 'c.json',
          schema: { type: 'object', properties: { size: { type: 'number' } } },
        },
      ]),
      'docs/guide',
    );
    expect(fields.get('size')?.type).toBe('text');
  });

  test('a schema declaring a property without a type constrains nothing', () => {
    const expected = { type: 'number', required: false, description: 'How heavy' };
    expect(fieldsForOrder([WEIGHT_UNTYPED, WEIGHT_NUMBER]).get('weight')).toEqual(expected);
    expect(fieldsForOrder([WEIGHT_NUMBER, WEIGHT_UNTYPED]).get('weight')).toEqual(expected);
  });

  test('the merged type is the same under every schema order', () => {
    const cases = [
      { schemas: [WEIGHT_UNTYPED, WEIGHT_NUMBER, WEIGHT_NUMBER], type: 'number' },
      { schemas: [WEIGHT_UNTYPED, WEIGHT_DATE], type: 'date' },
      { schemas: [WEIGHT_UNTYPED, WEIGHT_UNTYPED], type: 'text' },
      { schemas: [WEIGHT_REQUIRED_ONLY, WEIGHT_UNTYPED, WEIGHT_NUMBER], type: 'number' },
      // Two explicit, differing types still have no common widget.
      { schemas: [WEIGHT_UNTYPED, WEIGHT_NUMBER, WEIGHT_ARRAY], type: 'text' },
      { schemas: [WEIGHT_NUMBER, WEIGHT_ARRAY, WEIGHT_NUMBER], type: 'text' },
    ];
    for (const { schemas, type } of cases) {
      for (const order of permutations(schemas)) {
        expect(fieldsForOrder(order).get('weight')?.type).toBe(type);
      }
    }
  });

  test('required unions across schemas regardless of which one declares the field', () => {
    const fields = schemaFieldsForDoc(
      configWith([
        {
          appliesTo: 'docs/**',
          file: 'a.json',
          schema: { type: 'object', properties: { status: { type: 'string' } } },
        },
        { appliesTo: 'docs/**', file: 'b.json', schema: { type: 'object', required: ['status'] } },
      ]),
      'docs/guide',
    );
    expect(fields.get('status')).toEqual({ type: 'text', required: true });
  });

  test('the first description wins across schemas', () => {
    const fields = schemaFieldsForDoc(
      configWith([
        {
          appliesTo: 'docs/**',
          file: 'a.json',
          schema: { type: 'object', properties: { status: { description: 'First' } } },
        },
        {
          appliesTo: 'docs/**',
          file: 'b.json',
          schema: { type: 'object', properties: { status: { description: 'Second' } } },
        },
      ]),
      'docs/guide',
    );
    expect(fields.get('status')?.description).toBe('First');
  });

  test('a later schema supplies a description the first one omitted', () => {
    const fields = schemaFieldsForDoc(
      configWith([
        {
          appliesTo: 'docs/**',
          file: 'a.json',
          schema: { type: 'object', properties: { status: { type: 'string' } } },
        },
        {
          appliesTo: 'docs/**',
          file: 'b.json',
          schema: { type: 'object', properties: { status: { description: 'Later' } } },
        },
      ]),
      'docs/guide',
    );
    expect(fields.get('status')?.description).toBe('Later');
  });

  test('a non-matching doc, a disabled plugin, and no doc identity all yield nothing', () => {
    const config = configWith([{ appliesTo: 'docs/**', file: 'd.json', schema: DOC_SCHEMA }]);
    expect(schemaFieldsForDoc(config, 'specs/other').size).toBe(0);
    expect(schemaFieldsForDoc(configWith([], false), 'docs/guide').size).toBe(0);
    expect(schemaFieldsForDoc(config, undefined).size).toBe(0);
    expect(schemaFieldsForDoc(config, '').size).toBe(0);
    expect(schemaFieldsForDoc(null, 'docs/guide').size).toBe(0);
  });

  test('a toggled-off mapping declares nothing, matching the lint plugin', () => {
    const fields = schemaFieldsForDoc(
      configWith([{ appliesTo: 'docs/**', file: 'd.json', enabled: false, schema: DOC_SCHEMA }]),
      'docs/guide',
    );
    expect(fields.size).toBe(0);
  });

  test('a content-less mapping declares nothing', () => {
    const fields = schemaFieldsForDoc(
      configWith([{ appliesTo: 'docs/**', file: 'missing.json' }]),
      'docs/guide',
    );
    expect(fields.size).toBe(0);
  });
});
