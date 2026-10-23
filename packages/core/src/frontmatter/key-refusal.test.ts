import { describe, expect, test } from 'vitest';
import { Document } from 'yaml';
import { applyPatchToFm, applyPathSetToFm } from '../bridge/frontmatter-region.ts';
import { FrontmatterPatchRequestSchema } from '../schemas/api/agent-write.ts';
import { type FrontmatterPatch, FrontmatterPatchSchema, FrontmatterValueSchema } from './schema.ts';
import { applyPatchToDocument } from './yaml-codec.ts';

const cases: { name: string; patch: FrontmatterPatch }[] = [
  { name: 'top-level', patch: JSON.parse('{"__proto__":0,"keep":1}') },
  { name: 'nested object', patch: JSON.parse('{"key":{"__proto__":0,"keep":1}}') },
  { name: 'literal list', patch: JSON.parse('{"key":[{"__proto__":0}]}') },
  { name: 'nested lists', patch: JSON.parse('{"key":[[{"__proto__":0,"keep":1}]]}') },
  { name: 'object value', patch: JSON.parse('{"key":{"__proto__":{"value":true}}}') },
  { name: 'later invalid field', patch: JSON.parse('{"keep":2,"key":[{"__proto__":0}]}') },
];

describe('frontmatter key refusal', () => {
  test.each(cases)('rejects $name records at every shared schema entry', ({ patch }) => {
    expect.soft(FrontmatterValueSchema.safeParse(patch).success).toBe(false);
    expect.soft(FrontmatterPatchSchema.safeParse(patch).success).toBe(false);
    expect
      .soft(FrontmatterPatchRequestSchema.safeParse({ docName: 'note', patch }).success)
      .toBe(false);
  });

  test.each(cases)('refuses $name patches before changing YAML', ({ patch }) => {
    const doc = new Document({ keep: 'baseline', key: 'before' });
    const before = doc.toString();
    expect.soft(applyPatchToFm(`---\n${before}---\n`, patch).ok).toBe(false);
    expect.soft(() => applyPatchToDocument(doc, patch)).toThrow(Error);
    expect.soft(doc.toString()).toBe(before);
  });

  test('refuses the literal list through the path-value helper', () => {
    const value = JSON.parse('[{"__proto__":0}]');
    expect(applyPathSetToFm('---\nkey: before\n---\n', ['key'], value).ok).toBe(false);
  });

  test('preserves ordinary objects and the existing list scalar conversion', () => {
    const input = {
      key: {
        number: 7,
        flag: false,
        nested: { count: 3, yes: true },
        list: [0, true, false, ['x', 2], { count: 3, yes: true }],
        constructor: { prototype: 'ordinary' },
        prototype: 'ordinary',
      },
    };
    const expected = {
      key: {
        ...input.key,
        list: ['0', 'true', 'false', ['x', '2'], { count: 3, yes: true }],
      },
    };
    expect(FrontmatterPatchSchema.parse(input)).toEqual(expected);
  });
});
