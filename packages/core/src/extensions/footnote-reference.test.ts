import { describe, expect, test } from 'bun:test';
import {
  collectFootnoteIdentifiers,
  type FootnoteDescendableDoc,
  type FootnoteWalkableDoc,
  findFootnoteDefinitionInsertPos,
  nextFootnoteIdentifier,
} from './footnote-reference.ts';

/** Build a `FootnoteWalkableDoc` shim from a flat list of (type, size) pairs. */
function fakeDoc(blocks: Array<{ type: string; size: number }>): FootnoteWalkableDoc {
  return {
    content: { size: blocks.reduce((s, b) => s + b.size, 0) },
    forEach(cb) {
      let offset = 0;
      blocks.forEach((b, i) => {
        cb({ type: { name: b.type }, nodeSize: b.size }, offset, i);
        offset += b.size;
      });
    },
  };
}

describe('nextFootnoteIdentifier', () => {
  test('empty list → "1"', () => {
    expect(nextFootnoteIdentifier([])).toBe('1');
  });

  test('contiguous integers → max + 1', () => {
    expect(nextFootnoteIdentifier(['1', '2', '3'])).toBe('4');
  });

  test('non-contiguous integers → max + 1 (no gap-filling)', () => {
    expect(nextFootnoteIdentifier(['1', '3', '5'])).toBe('6');
  });

  test('non-numeric identifiers are ignored', () => {
    // Authors can rename to `[^note]` etc. The auto-numbering rule walks
    // only the integer-shaped ones — non-numeric existing IDs never block
    // a new integer slot.
    expect(nextFootnoteIdentifier(['note', 'aside', 'footnote-x'])).toBe('1');
  });

  test('mixed numeric + non-numeric → max numeric + 1', () => {
    expect(nextFootnoteIdentifier(['1', 'note', '4', 'aside'])).toBe('5');
  });

  test('empty string / whitespace-only ids treated as non-numeric', () => {
    expect(nextFootnoteIdentifier(['', '   ', '2'])).toBe('3');
  });

  test('negative integers do not lower the floor', () => {
    // `parseInt('-3', 10)` → -3, which is `< maxId` (initialized to 0), so
    // the floor stays at 0 and the next ID is "1". Locks the
    // negative-doesn-decrease invariant against a future refactor that
    // might switch to `Math.max(maxId, n)` with an inappropriate seed.
    expect(nextFootnoteIdentifier(['-3', '-1'])).toBe('1');
  });

  test('numeric-with-suffix ("3a") parses to integer prefix and counts', () => {
    // `parseInt('3a', 10)` → 3. Matches JS's parseInt prefix-tolerance —
    // documenting the observable behavior so a future change to
    // `Number()` parsing (stricter) is a deliberate decision.
    expect(nextFootnoteIdentifier(['3a', '5b'])).toBe('6');
  });
});

describe('findFootnoteDefinitionInsertPos', () => {
  test('empty doc → 0 (insert at very start)', () => {
    const doc = fakeDoc([]);
    expect(findFootnoteDefinitionInsertPos(doc)).toBe(0);
  });

  test('no footnote — returns doc end', () => {
    // [heading(size=10), paragraph(size=20)]
    const doc = fakeDoc([
      { type: 'heading', size: 10 },
      { type: 'paragraph', size: 20 },
    ]);
    expect(findFootnoteDefinitionInsertPos(doc)).toBe(30);
  });

  test('one footnote at end — returns position right after it', () => {
    // [heading(10), paragraph(20), footnoteDefinition(15)]
    // last footnoteDef ends at offset 10+20+15 = 45
    const doc = fakeDoc([
      { type: 'heading', size: 10 },
      { type: 'paragraph', size: 20 },
      { type: 'footnoteDefinition', size: 15 },
    ]);
    expect(findFootnoteDefinitionInsertPos(doc)).toBe(45);
  });

  test('multiple consecutive footnotes — returns end of LAST', () => {
    const doc = fakeDoc([
      { type: 'paragraph', size: 10 },
      { type: 'footnoteDefinition', size: 5 },
      { type: 'footnoteDefinition', size: 7 },
      { type: 'footnoteDefinition', size: 4 },
    ]);
    // last fnDef ends at 10+5+7+4 = 26
    expect(findFootnoteDefinitionInsertPos(doc)).toBe(26);
  });

  test('footnote followed by non-footnote — returns end of footnote (NOT doc end)', () => {
    // Real-world shape: PM appends a trailing empty paragraph after the
    // last footnoteDefinition. We want to insert BEFORE that trailing
    // paragraph so the new footnote joins the existing group without
    // a blank paragraph slotted between them.
    const doc = fakeDoc([
      { type: 'heading', size: 10 },
      { type: 'footnoteDefinition', size: 12 },
      { type: 'paragraph', size: 2 }, // trailing empty p
    ]);
    // last fnDef ends at 10+12 = 22, not 24
    expect(findFootnoteDefinitionInsertPos(doc)).toBe(22);
  });

  test('footnote mid-doc with trailing content — uses end of LAST footnote', () => {
    // Unusual shape but valid: a footnoteDefinition followed by other
    // prose, then ANOTHER footnoteDefinition later. Insert after the
    // later one, keeping the group at the end.
    const doc = fakeDoc([
      { type: 'paragraph', size: 5 },
      { type: 'footnoteDefinition', size: 3 },
      { type: 'paragraph', size: 4 },
      { type: 'footnoteDefinition', size: 6 },
      { type: 'paragraph', size: 2 }, // trailing empty p
    ]);
    // last fnDef ends at 5+3+4+6 = 18
    expect(findFootnoteDefinitionInsertPos(doc)).toBe(18);
  });
});

describe('collectFootnoteIdentifiers', () => {
  function fakeDescendable(
    nodes: Array<{ type: string; identifier?: unknown }>,
  ): FootnoteDescendableDoc {
    return {
      descendants(cb) {
        let pos = 0;
        for (const n of nodes) {
          cb({ type: { name: n.type }, attrs: { identifier: n.identifier } }, pos);
          pos += 1;
        }
      },
    };
  }

  test('empty doc → empty array', () => {
    expect(collectFootnoteIdentifiers(fakeDescendable([]))).toEqual([]);
  });

  test('skips non-footnoteDefinition nodes', () => {
    const doc = fakeDescendable([
      { type: 'paragraph' },
      { type: 'heading' },
      { type: 'footnoteDefinition', identifier: '1' },
      { type: 'paragraph' },
    ]);
    expect(collectFootnoteIdentifiers(doc)).toEqual(['1']);
  });

  test('preserves doc order across multiple footnotes', () => {
    const doc = fakeDescendable([
      { type: 'footnoteDefinition', identifier: '3' },
      { type: 'footnoteDefinition', identifier: '1' },
      { type: 'footnoteDefinition', identifier: 'note' },
    ]);
    expect(collectFootnoteIdentifiers(doc)).toEqual(['3', '1', 'note']);
  });

  test('coerces null / missing identifier to empty string', () => {
    // Matches the existing collection sites' `String(node.attrs.identifier ?? '')`
    // behavior — nextFootnoteIdentifier ignores non-integer entries, so an
    // empty-string identifier doesn't poison the auto-numbering allocation.
    const doc = fakeDescendable([
      { type: 'footnoteDefinition', identifier: null },
      { type: 'footnoteDefinition' },
      { type: 'footnoteDefinition', identifier: '2' },
    ]);
    expect(collectFootnoteIdentifiers(doc)).toEqual(['', '', '2']);
  });

  test('round-trips into nextFootnoteIdentifier', () => {
    // Belt-and-suspenders integration test pinning the typical use:
    // collect → nextId. Catches regressions where one side's contract
    // drifts away from the other.
    const doc = fakeDescendable([
      { type: 'paragraph' },
      { type: 'footnoteDefinition', identifier: '1' },
      { type: 'footnoteDefinition', identifier: '2' },
    ]);
    expect(nextFootnoteIdentifier(collectFootnoteIdentifiers(doc))).toBe('3');
  });
});
