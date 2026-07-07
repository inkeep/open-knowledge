import { describe, expect, test } from 'bun:test';
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
    // The existing-key fixture uses `density: cozy` — a fictional
    // appearance sibling chosen so loose-mode YAML round-trips it
    // without coupling the test to a real schema leaf. The point is
    // that `applyPatchToDocument` doesn't clobber unrelated siblings
    // when patching one key under the same parent.
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
