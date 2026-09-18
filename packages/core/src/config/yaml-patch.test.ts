import { describe, expect, test } from 'vitest';
import { parseDocument } from 'yaml';
import { applyPatchToDocument } from './yaml-patch.ts';

describe('applyPatchToDocument — auto-vivification through scalar intermediates', () => {
  test('null-bodied parent (`appearance:` with no body) is replaced before descent', () => {
    const doc = parseDocument('appearance:\n');
    expect(doc.getIn(['appearance'])).toBeNull();

    const applied = applyPatchToDocument(doc, {
      appearance: { theme: 'dark' },
    } as never);

    expect(applied).toEqual(['appearance.theme']);
    expect(doc.getIn(['appearance', 'theme'])).toBe('dark');
    expect(doc.toString()).toContain('theme: dark');
  });

  test('explicit-null parent (`appearance: ~`) is replaced before descent', () => {
    const doc = parseDocument('appearance: ~\n');

    const applied = applyPatchToDocument(doc, {
      appearance: { theme: 'light' },
    } as never);

    expect(applied).toEqual(['appearance.theme']);
    expect(doc.getIn(['appearance', 'theme'])).toBe('light');
  });

  test('scalar-bodied parent is replaced before descent', () => {
    const doc = parseDocument('appearance: "wat"\n');

    const applied = applyPatchToDocument(doc, {
      appearance: { theme: 'system' },
    } as never);

    expect(applied).toEqual(['appearance.theme']);
    expect(doc.getIn(['appearance', 'theme'])).toBe('system');
    expect(doc.getIn(['appearance']) as unknown).not.toBe('wat');
  });

  test('deeply nested scalar intermediate (mcp.tools = null) is replaced', () => {
    const doc = parseDocument('mcp:\n  tools:\n');
    expect(doc.getIn(['mcp', 'tools'])).toBeNull();

    const applied = applyPatchToDocument(doc, {
      mcp: { tools: { grep: { maxResults: 50 } } },
    } as never);

    expect(applied).toEqual(['mcp.tools.grep.maxResults']);
    expect(doc.getIn(['mcp', 'tools', 'grep', 'maxResults'])).toBe(50);
  });

  test('existing populated parent is preserved (no clobber)', () => {
    const doc = parseDocument('appearance:\n  density: cozy\n');

    const applied = applyPatchToDocument(doc, {
      appearance: { theme: 'dark' },
    } as never);

    expect(applied).toEqual(['appearance.theme']);
    expect(doc.getIn(['appearance', 'density'])).toBe('cozy');
    expect(doc.getIn(['appearance', 'theme'])).toBe('dark');
  });

  test('array leaf through scalar intermediate is auto-vivified', () => {
    const doc = parseDocument('content:\n');

    const applied = applyPatchToDocument(doc, {
      content: { include: ['**/*.md'] },
    } as never);

    expect(applied).toEqual(['content.include']);
    expect(doc.getIn(['content', 'include', 0])).toBe('**/*.md');
  });
});

describe('applyPatchToDocument — deleting the last key prunes the emptied parent', () => {
  test('parent map is removed once its final child is deleted', () => {
    const doc = parseDocument('bridge:\n  deferGuard:\n    enabled: true\n');

    const applied = applyPatchToDocument(doc, {
      bridge: { deferGuard: null },
    } as never);

    expect(applied).toEqual(['bridge.deferGuard']);
    expect(doc.has('bridge')).toBe(false);
    expect(doc.toString()).not.toContain('bridge');
  });

  test('parent map survives while it still holds another key', () => {
    const doc = parseDocument('bridge:\n  deferGuard:\n    enabled: true\n  keep: 1\n');

    applyPatchToDocument(doc, { bridge: { deferGuard: null } } as never);

    expect(doc.has('bridge')).toBe(true);
    expect(doc.getIn(['bridge', 'keep'])).toBe(1);
  });

  test('clearing every retired key leaves no husk behind', () => {
    const doc = parseDocument(
      'content:\n  dir: .\nbridge:\n  deferGuard:\n    enabled: true\n  fixedPoint:\n    enabled: true\n  preDrain:\n    enabled: true\n  lossDetector:\n    enabled: true\n',
    );

    applyPatchToDocument(doc, {
      bridge: { deferGuard: null, fixedPoint: null, preDrain: null, lossDetector: null },
    } as never);

    expect(doc.has('bridge')).toBe(false);
    expect(doc.getIn(['content', 'dir'])).toBe('.');
  });

  test('nested empties prune upward, stopping at the first populated ancestor', () => {
    const doc = parseDocument('a:\n  keep: 1\n  b:\n    c:\n      d: true\n');

    applyPatchToDocument(doc, { a: { b: { c: { d: null } } } } as never);

    expect(doc.hasIn(['a', 'b'])).toBe(false);
    expect(doc.getIn(['a', 'keep'])).toBe(1);
  });
});
