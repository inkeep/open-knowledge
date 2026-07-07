import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import {
  applyPatchToDocument,
  getDocumentKeys,
  parseFrontmatterYaml,
  serializeFrontmatterMap,
  withFences,
} from './yaml-codec.ts';

const PBT_NUM_RUNS = process.env.STRESS_FIDELITY === '1' ? 1_000 : 100;

describe('parseFrontmatterYaml', () => {
  test('empty input → empty map + fresh Document', () => {
    const { doc, map } = parseFrontmatterYaml('');
    expect(map).toEqual({});
    expect(doc).toBeDefined();
  });

  test('whitespace-only input → empty map', () => {
    expect(parseFrontmatterYaml('   \n\n   ').map).toEqual({});
  });

  test('parses scalar values across all five widget shapes', () => {
    const yaml = [
      'title: Hello',
      'count: 42',
      'draft: false',
      'date: 2026-04-24',
      'tags:',
      '  - one',
      '  - two',
    ].join('\n');
    const { map } = parseFrontmatterYaml(yaml);
    expect(map).toEqual({
      title: 'Hello',
      count: 42,
      draft: false,
      date: '2026-04-24',
      tags: ['one', 'two'],
    });
  });

  test('preserves comments via parseDocument', () => {
    const yaml = '# spec owner\ntitle: Foo\n# end\n';
    const { doc, map } = parseFrontmatterYaml(yaml);
    expect(map).toEqual({ title: 'Foo' });
    const out = doc.toString();
    expect(out).toContain('# spec owner');
    expect(out).toContain('# end');
  });

  test('returns null map on malformed YAML', () => {
    const { map } = parseFrontmatterYaml('title: [unterminated');
    expect(map).toBeNull();
  });

  test('returns null map when top-level value is not a mapping', () => {
    expect(parseFrontmatterYaml('- one\n- two').map).toBeNull();
    expect(parseFrontmatterYaml('"just a string"').map).toBeNull();
  });

  test("coerces Obsidian's empty-list / bare-key null shapes instead of rejecting the map", () => {
    // The disk-side parser shares `FrontmatterMapSchema` with the panel
    // binding, so the same Obsidian null coercion applies on load: an empty
    // `tags:\n- ` block sequence reads as an empty list, a bare `tags:` reads
    // as an empty string, and neither hides the file's other keys.
    expect(parseFrontmatterYaml('tags:\n- \n').map).toEqual({ tags: [] });
    expect(parseFrontmatterYaml('tags:\n').map).toEqual({ tags: '' });
    const mixed = parseFrontmatterYaml('plugin-id: dataview\ntags:\n- \npublish: true\n');
    expect(mixed.parseError).toBeUndefined();
    expect(mixed.map).toEqual({ 'plugin-id': 'dataview', tags: [], publish: true });
  });

  test('parses nested objects into a populated map with no parseError', () => {
    // Recursive value contract — nested mappings round-trip as native JS
    // objects so the property panel can render them as expandable rows.
    const yaml = 'name: skill\nmetadata:\n  version: 1.0.0\n  author: Inkeep\n';
    const { map, parseError } = parseFrontmatterYaml(yaml);
    expect(parseError).toBeUndefined();
    expect(map).toEqual({
      name: 'skill',
      metadata: { version: '1.0.0', author: 'Inkeep' },
    });
  });

  test('parses arbitrarily deep nesting + arrays of objects with no parseError', () => {
    const yaml =
      'name: skill\n' +
      'items:\n' +
      '  - title: a\n' +
      '    nested:\n' +
      '      deep: ok\n' +
      '  - title: b\n';
    const { map, parseError } = parseFrontmatterYaml(yaml);
    expect(parseError).toBeUndefined();
    expect(map).toEqual({
      name: 'skill',
      items: [{ title: 'a', nested: { deep: 'ok' } }, { title: 'b' }],
    });
  });

  test('object array elements are NOT String-coerced (scalar-only coercion)', () => {
    // Scalar elements still coerce to string (`2026` → `'2026'`) so the tag
    // indexer + flat list widget stay convergent; object elements pass
    // through as-is. Without this, `String({})` would yield
    // `'[object Object]'` and corrupt nested data on every parse.
    const yaml = 'items:\n  - {a: 1}\n  - tag\n  - 2026\n';
    const { map, parseError } = parseFrontmatterYaml(yaml);
    expect(parseError).toBeUndefined();
    expect(map?.items).toEqual([{ a: 1 }, 'tag', '2026']);
  });

  test('returns null map on genuinely malformed YAML (yaml@2 parse error)', () => {
    // After the recursive widening, parseError is reserved for genuine
    // yaml@2 errors and non-mapping top levels — NOT for nested values.
    const { map, parseError } = parseFrontmatterYaml('title: foo: bar');
    expect(map).toBeNull();
    expect(parseError).toBeDefined();
  });

  test('coerces non-string scalars in array values to strings', () => {
    expect(parseFrontmatterYaml('tags: [1, 2, 3]').map).toEqual({ tags: ['1', '2', '3'] });
  });

  test('preserves user-source key order', () => {
    const { doc } = parseFrontmatterYaml('z: 1\na: 2\nm: 3\n');
    expect(getDocumentKeys(doc)).toEqual(['z', 'a', 'm']);
  });
});

describe('serializeFrontmatterMap', () => {
  test('empty map → empty string', () => {
    expect(serializeFrontmatterMap({})).toBe('');
  });

  test('preserves insertion order across runs (deterministic)', () => {
    const map = { z: 1, a: 'two', m: true };
    const yaml1 = serializeFrontmatterMap(map);
    const yaml2 = serializeFrontmatterMap(map);
    expect(yaml1).toBe(yaml2);
    const lines = yaml1.trim().split('\n');
    expect(lines[0]).toMatch(/^z:/);
    expect(lines[1]).toMatch(/^a:/);
    expect(lines[2]).toMatch(/^m:/);
  });

  test('serializes lists in YAML block form', () => {
    const yaml = serializeFrontmatterMap({ tags: ['a', 'b'] });
    expect(yaml).toContain('tags:');
    expect(yaml).toContain('- a');
    expect(yaml).toContain('- b');
  });

  test('does not emit anchors or aliases for repeated values', () => {
    const repeated = 'shared-value';
    const yaml = serializeFrontmatterMap({ a: repeated, b: repeated });
    expect(yaml).not.toContain('&');
    expect(yaml).not.toContain('*');
  });
});

describe('round-trip: parse(serialize(map)) === map', () => {
  test('fixture: five widget shapes', () => {
    const map = {
      title: 'Hello World',
      count: 42,
      draft: true,
      date: '2026-04-24',
      tags: ['docs', 'crdt', 'mcp'],
    };
    const yaml = serializeFrontmatterMap(map);
    const { map: parsed } = parseFrontmatterYaml(yaml);
    expect(parsed).toEqual(map);
  });

  test('fixture: Unicode + non-ASCII strings', () => {
    const map = {
      title: '日本語のタイトル',
      author: 'Renée Zellweger',
      emoji: 'rocket-launching',
    };
    const yaml = serializeFrontmatterMap(map);
    expect(parseFrontmatterYaml(yaml).map).toEqual(map);
  });

  test('fixture: special-character strings (colons, dashes, hashes)', () => {
    const map = {
      url: 'https://example.com/path?q=1',
      note: 'a # not a comment',
      title: '- not a list',
    };
    const yaml = serializeFrontmatterMap(map);
    expect(parseFrontmatterYaml(yaml).map).toEqual(map);
  });

  test('PBT: parse(serialize(map)) === map', () => {
    const safeKey = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(s));
    const safeString = fc
      .string({ maxLength: 80 })
      .filter((s) => !s.includes('\n') && !s.includes('\r'));
    const valueArb = fc.oneof(
      safeString,
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.boolean(),
      fc.array(safeString, { maxLength: 8 }),
    );
    fc.assert(
      fc.property(fc.dictionary(safeKey, valueArb, { maxKeys: 10 }), (map) => {
        const yaml = serializeFrontmatterMap(map);
        const { map: parsed } = parseFrontmatterYaml(yaml);
        expect(parsed).toEqual(map);
      }),
      { numRuns: PBT_NUM_RUNS },
    );
  });
});

describe('round-trip: serialize(parse(yaml)) is canonical and idempotent', () => {
  test('canonical form is byte-stable on subsequent saves', () => {
    const yaml = 'title: Hello\ncount: 42\ntags:\n  - a\n  - b\n';
    const { map } = parseFrontmatterYaml(yaml);
    if (map === null) throw new Error('expected parse to succeed');
    const canonical = serializeFrontmatterMap(map);
    const round2 = serializeFrontmatterMap(parseFrontmatterYaml(canonical).map ?? {});
    expect(round2).toBe(canonical);
  });
});

describe('applyPatchToDocument', () => {
  test('preserves comments on untouched keys', () => {
    const { doc } = parseFrontmatterYaml('# owner\ntitle: Foo\ndraft: true\n');
    const out = applyPatchToDocument(doc, { draft: false });
    expect(out).toContain('# owner');
    expect(out).toContain('title: Foo');
    expect(out).toMatch(/draft:\s*false/);
  });

  test('null deletes the key', () => {
    const { doc } = parseFrontmatterYaml('title: Foo\ndraft: true\n');
    const out = applyPatchToDocument(doc, { draft: null });
    expect(out).toContain('title: Foo');
    expect(out).not.toContain('draft');
  });

  test('creates new keys at the end', () => {
    const { doc } = parseFrontmatterYaml('title: Foo\n');
    const out = applyPatchToDocument(doc, { status: 'published' });
    expect(out).toContain('title: Foo');
    expect(out).toContain('status: published');
  });

  test('coerces non-string scalars when patching arrays', () => {
    const { doc } = parseFrontmatterYaml('title: Foo\n');
    const out = applyPatchToDocument(doc, { tags: [1, 2, 3] });
    const reparsed = parseFrontmatterYaml(out).map;
    expect(reparsed?.tags).toEqual(['1', '2', '3']);
  });

  test('preserves flow-style array when patching an existing flow array', () => {
    const { doc } = parseFrontmatterYaml('tags: [a, b, c]\n');
    const out = applyPatchToDocument(doc, { tags: ['a', 'b', 'c', 'd'] });
    expect(out).toContain('tags: [');
  });

  test('preserves block-style array when patching an existing block array', () => {
    const { doc } = parseFrontmatterYaml('tags:\n  - a\n  - b\n');
    const out = applyPatchToDocument(doc, { tags: ['a', 'b', 'c'] });
    expect(out).toMatch(/tags:\s*\n\s*-\s/);
  });

  test('nested object patch replaces the subtree, preserving sibling top-level keys', () => {
    const { doc } = parseFrontmatterYaml(
      'name: skill\nmetadata:\n  version: 1.0.0\n  author: Inkeep\ndescription: hello\n',
    );
    const out = applyPatchToDocument(doc, {
      metadata: { version: '2.0.0', author: 'Inkeep' },
    });
    const reparsed = parseFrontmatterYaml(out).map;
    expect(reparsed).toEqual({
      name: 'skill',
      metadata: { version: '2.0.0', author: 'Inkeep' },
      description: 'hello',
    });
  });

  test('null deletes a nested-object subtree key', () => {
    const { doc } = parseFrontmatterYaml(
      'name: skill\nmetadata:\n  version: 1.0.0\ndescription: hello\n',
    );
    const out = applyPatchToDocument(doc, { metadata: null });
    expect(out).not.toContain('metadata');
    expect(out).toContain('name: skill');
    expect(out).toContain('description: hello');
  });

  test('non-object value replaces an existing object subtree', () => {
    const { doc } = parseFrontmatterYaml(
      'name: skill\nmetadata:\n  version: 1.0.0\n  author: Inkeep\n',
    );
    const out = applyPatchToDocument(doc, { metadata: 'inline-value' });
    expect(parseFrontmatterYaml(out).map).toEqual({
      name: 'skill',
      metadata: 'inline-value',
    });
  });

  test('nested object value replaces an existing scalar key', () => {
    const { doc } = parseFrontmatterYaml('name: skill\n');
    const out = applyPatchToDocument(doc, {
      name: { kind: 'skill', detail: 'x' },
    });
    expect(parseFrontmatterYaml(out).map).toEqual({
      name: { kind: 'skill', detail: 'x' },
    });
  });

  test('arbitrarily-deep nested set builds the full subtree', () => {
    const { doc } = parseFrontmatterYaml('name: skill\n');
    const out = applyPatchToDocument(doc, {
      outer: { inner: { leaf: 'ok' } },
    });
    expect(parseFrontmatterYaml(out).map).toEqual({
      name: 'skill',
      outer: { inner: { leaf: 'ok' } },
    });
  });

  test('preserves comments on untouched sibling keys across a nested-subtree edit', () => {
    const yaml =
      '# leading comment\nname: skill\n# metadata block\nmetadata:\n  version: 1.0.0\n# trailing comment on description\ndescription: hello\n';
    const { doc } = parseFrontmatterYaml(yaml);
    const out = applyPatchToDocument(doc, {
      metadata: { version: '2.0.0' },
    });
    expect(out).toContain('# leading comment');
    expect(out).toContain('# trailing comment on description');
    expect(out).toContain('name: skill');
    expect(out).toContain('description: hello');
  });

  test('preserves flow-style nested map when replacing the subtree', () => {
    const { doc } = parseFrontmatterYaml('metadata: {version: 1.0, author: Inkeep}\n');
    const out = applyPatchToDocument(doc, {
      metadata: { version: '2.0', author: 'Inkeep' },
    });
    expect(out).toContain('metadata: {');
  });

  test('preserves block-style nested map when replacing the subtree', () => {
    const { doc } = parseFrontmatterYaml('metadata:\n  version: 1.0\n  author: Inkeep\n');
    const out = applyPatchToDocument(doc, {
      metadata: { version: '2.0', author: 'Inkeep' },
    });
    expect(out).toMatch(/metadata:\s*\n\s+version:/);
  });

  test('round-trip is idempotent: applying the same nested patch twice is byte-stable', () => {
    const baseYaml = 'name: skill\nmetadata:\n  version: 1.0.0\n  author: Inkeep\n';
    const first = applyPatchToDocument(parseFrontmatterYaml(baseYaml).doc, {
      metadata: { version: '2.0.0', author: 'Inkeep' },
    });
    const second = applyPatchToDocument(parseFrontmatterYaml(first).doc, {
      metadata: { version: '2.0.0', author: 'Inkeep' },
    });
    expect(second).toBe(first);
  });
});

describe('withFences', () => {
  test('wraps non-empty body with --- fences', () => {
    expect(withFences('title: Foo\n')).toBe('---\ntitle: Foo\n---\n');
  });

  test('empty body → empty output', () => {
    expect(withFences('')).toBe('');
  });

  test('handles body without trailing newline', () => {
    expect(withFences('title: Foo')).toBe('---\ntitle: Foo\n---\n');
  });
});
