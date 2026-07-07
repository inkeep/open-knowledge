/**
 * Pure unit tests for the okignore-doc parser + serializer + structural ops.
 *
 * The byte-identical round-trip property is the critical invariant — every
 * mutation op composes against `serializeOkignoreDoc(parseOkignoreDoc(text))`
 * and the no-edit path must be a no-op.
 */

import { describe, expect, test } from 'bun:test';
import {
  appendPattern,
  editPatternAt,
  findPatternIndex,
  listPatterns,
  parseOkignoreDoc,
  removePatternAt,
  reorderPatterns,
  serializeOkignoreDoc,
} from './okignore-doc';

const ROUND_TRIP_FIXTURES: { name: string; text: string }[] = [
  { name: 'empty body', text: '' },
  { name: 'single pattern no trailing newline', text: 'drafts/' },
  { name: 'single pattern with trailing newline', text: 'drafts/\n' },
  { name: 'two patterns trailing newline', text: 'drafts/\n*.draft.md\n' },
  { name: 'two patterns no trailing newline', text: 'drafts/\n*.draft.md' },
  { name: 'leading + trailing comments', text: '# header\ndrafts/\n# footer\n' },
  { name: 'blank line in middle', text: 'drafts/\n\nvendor/\n' },
  { name: 'multi-blank cluster', text: 'a\n\n\n\nb\n' },
  { name: 'whitespace-only line', text: 'a\n   \nb\n' },
  { name: 'pattern with leading whitespace preserved', text: '  drafts/\n*.tmp\n' },
  { name: 'commented + blank + pattern interleaved', text: '# a\n\ndrafts/\n# b\n\nvendor/\n' },
  { name: 'cr inside line preserved verbatim', text: 'drafts\r/\nvendor/\n' },
  {
    name: 'realistic mixed body',
    text: '# Drafts\ndrafts/\n\n# Vendor pastes\nvendor/\n*.draft.md\n\n# done\n',
  },
];

describe('parseOkignoreDoc + serializeOkignoreDoc — byte-identical round-trip', () => {
  for (const { name, text } of ROUND_TRIP_FIXTURES) {
    test(`round-trip preserves: ${name}`, () => {
      const doc = parseOkignoreDoc(text);
      const out = serializeOkignoreDoc(doc);
      expect(out).toBe(text);
    });
  }
});

describe('parseOkignoreDoc — line classification', () => {
  test('truly empty body yields one blank line', () => {
    const doc = parseOkignoreDoc('');
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toEqual({ kind: 'blank', raw: '' });
  });

  test('classifies blank, comment, pattern correctly', () => {
    const doc = parseOkignoreDoc('# c\n\n   \ndrafts/\n  vendor/  \n');
    const kinds = doc.lines.map((l) => l.kind);
    expect(kinds).toEqual(['comment', 'blank', 'blank', 'pattern', 'pattern', 'blank']);
  });

  test('whitespace-only line classifies as blank (NOT pattern)', () => {
    // L3 rejects whitespace-only lines but the parser must preserve them
    // verbatim — adversarial bodies shouldn't crash the parser.
    const doc = parseOkignoreDoc('   \n');
    expect(doc.lines[0]).toEqual({ kind: 'blank', raw: '   ' });
  });

  test('pattern line stores trimmed text but raw preserves whitespace', () => {
    const doc = parseOkignoreDoc('  drafts/  \n');
    const first = doc.lines[0];
    expect(first.kind).toBe('pattern');
    if (first.kind === 'pattern') {
      expect(first.text).toBe('drafts/');
      expect(first.raw).toBe('  drafts/  ');
    }
  });

  test('comment line with leading whitespace classifies as comment', () => {
    const doc = parseOkignoreDoc('  # not a pattern\n');
    expect(doc.lines[0]?.kind).toBe('comment');
    expect(doc.lines[0]?.raw).toBe('  # not a pattern');
  });

  test('pattern that contains # mid-line is still a pattern', () => {
    const doc = parseOkignoreDoc('drafts/#nope\n');
    const first = doc.lines[0];
    expect(first.kind).toBe('pattern');
    if (first.kind === 'pattern') {
      expect(first.text).toBe('drafts/#nope');
    }
  });
});

describe('listPatterns', () => {
  test('returns only pattern lines in document order', () => {
    const doc = parseOkignoreDoc('# c\ndrafts/\n\nvendor/\n# d\n');
    const patterns = listPatterns(doc);
    expect(patterns.map((p) => p.text)).toEqual(['drafts/', 'vendor/']);
  });

  test('returns empty array for empty doc', () => {
    expect(listPatterns(parseOkignoreDoc(''))).toEqual([]);
  });

  test('returns empty array for comments-only doc', () => {
    expect(listPatterns(parseOkignoreDoc('# header\n# more\n'))).toEqual([]);
  });
});

describe('appendPattern', () => {
  test('appends to empty doc with trailing newline', () => {
    const next = appendPattern(parseOkignoreDoc(''), 'drafts/');
    expect(serializeOkignoreDoc(next)).toBe('drafts/\n');
  });

  test('appends to doc that already ends with newline', () => {
    const next = appendPattern(parseOkignoreDoc('a/\n'), 'b/');
    expect(serializeOkignoreDoc(next)).toBe('a/\nb/\n');
  });

  test('appends to doc that does NOT end with newline', () => {
    const next = appendPattern(parseOkignoreDoc('a/'), 'b/');
    expect(serializeOkignoreDoc(next)).toBe('a/\nb/\n');
  });

  test('preserves comments and blank lines verbatim through append', () => {
    const text = '# Drafts\ndrafts/\n\n# Vendor\nvendor/\n';
    const next = appendPattern(parseOkignoreDoc(text), '*.tmp');
    expect(serializeOkignoreDoc(next)).toBe(`${text}*.tmp\n`);
  });

  test('trims input pattern (mirrors L3 server-side strip)', () => {
    const next = appendPattern(parseOkignoreDoc(''), '   drafts/   ');
    expect(serializeOkignoreDoc(next)).toBe('drafts/\n');
  });

  test('empty/whitespace-only input returns the doc unchanged', () => {
    const original = parseOkignoreDoc('a/\n');
    expect(appendPattern(original, '')).toBe(original);
    expect(appendPattern(original, '   ')).toBe(original);
    expect(appendPattern(original, '\t\n')).toBe(original);
  });

  test('exact-match duplicate returns the same doc reference (no-op)', () => {
    const original = parseOkignoreDoc('drafts/\nvendor/\n');
    expect(appendPattern(original, 'drafts/')).toBe(original);
    expect(appendPattern(original, 'vendor/')).toBe(original);
  });

  test('duplicate detection compares trimmed input against trimmed pattern text', () => {
    const original = parseOkignoreDoc('drafts/\n');
    expect(appendPattern(original, '  drafts/  ')).toBe(original);
    expect(appendPattern(original, '\tdrafts/\n')).toBe(original);
  });

  test('duplicate detection ignores comments that happen to match', () => {
    const original = parseOkignoreDoc('# drafts/\n');
    const next = appendPattern(original, 'drafts/');
    expect(next).not.toBe(original);
    expect(serializeOkignoreDoc(next)).toBe('# drafts/\ndrafts/\n');
  });

  test('different pattern still appends after a duplicate is rejected', () => {
    const original = parseOkignoreDoc('drafts/\n');
    expect(appendPattern(original, 'drafts/')).toBe(original);
    const next = appendPattern(original, 'vendor/');
    expect(serializeOkignoreDoc(next)).toBe('drafts/\nvendor/\n');
  });

  test('dedup matches anywhere in the doc, not only the last pattern', () => {
    const original = parseOkignoreDoc('drafts/\n# comment\nvendor/\n');
    expect(appendPattern(original, 'drafts/')).toBe(original);
    expect(appendPattern(original, 'vendor/')).toBe(original);
  });

  test('dedup is case-sensitive (gitignore semantics)', () => {
    const original = parseOkignoreDoc('Drafts/\n');
    const next = appendPattern(original, 'drafts/');
    expect(next).not.toBe(original);
    expect(serializeOkignoreDoc(next)).toBe('Drafts/\ndrafts/\n');
  });

  test('doc that already contains the duplicate twice still short-circuits — does not strip later duplicates', () => {
    // A future "while we're here, also strip later duplicates" refactor would
    // silently start mutating the doc and still pass every other case in this
    // suite. Pin first-match short-circuit explicitly.
    const original = parseOkignoreDoc('drafts/\ndrafts/\n');
    expect(appendPattern(original, 'drafts/')).toBe(original);
    expect(serializeOkignoreDoc(original)).toBe('drafts/\ndrafts/\n');
  });
});

describe('findPatternIndex', () => {
  test('returns pattern-only index for an exact trimmed match', () => {
    const doc = parseOkignoreDoc('drafts/\n# c\nvendor/\n');
    expect(findPatternIndex(doc, 'drafts/')).toBe(0);
    expect(findPatternIndex(doc, 'vendor/')).toBe(1);
  });

  test('trims the query before comparing', () => {
    const doc = parseOkignoreDoc('drafts/\n');
    expect(findPatternIndex(doc, '  drafts/  ')).toBe(0);
  });

  test('returns -1 for no match', () => {
    const doc = parseOkignoreDoc('drafts/\n');
    expect(findPatternIndex(doc, 'vendor/')).toBe(-1);
  });

  test('returns -1 for whitespace-only query', () => {
    const doc = parseOkignoreDoc('drafts/\n');
    expect(findPatternIndex(doc, '   ')).toBe(-1);
    expect(findPatternIndex(doc, '')).toBe(-1);
  });

  test('does not match comment lines', () => {
    const doc = parseOkignoreDoc('# drafts/\n');
    expect(findPatternIndex(doc, 'drafts/')).toBe(-1);
  });

  test('returns the pattern-only index when comments precede patterns', () => {
    // Load-bearing for the Settings handleAdd dedup-flash path: the returned
    // index flows into rowFlashKey(trimmed, existingIndex) which targets the
    // n-th pattern row. If comments leaked into the count, the flash would
    // land on the wrong row. Other tests use docs where the naive line index
    // and pattern-only index happen to agree — this one explicitly diverges.
    const doc = parseOkignoreDoc('# c\ndrafts/\nvendor/\n');
    expect(findPatternIndex(doc, 'drafts/')).toBe(0);
    expect(findPatternIndex(doc, 'vendor/')).toBe(1);
  });
});

describe('editPatternAt', () => {
  test('replaces the n-th pattern with the trimmed new text', () => {
    const text = '# c\ndrafts/\nvendor/\n';
    const next = editPatternAt(parseOkignoreDoc(text), 1, '*.tmp');
    expect(serializeOkignoreDoc(next)).toBe('# c\ndrafts/\n*.tmp\n');
  });

  test('preserves comments + blank lines through edit', () => {
    const text = '# A\n\ndrafts/\n# B\n\nvendor/\n';
    const next = editPatternAt(parseOkignoreDoc(text), 0, '*.draft.md');
    expect(serializeOkignoreDoc(next)).toBe('# A\n\n*.draft.md\n# B\n\nvendor/\n');
  });

  test('trims new text on edit (loses leading/trailing whitespace)', () => {
    const next = editPatternAt(parseOkignoreDoc('drafts/\n'), 0, '   *.tmp   ');
    expect(serializeOkignoreDoc(next)).toBe('*.tmp\n');
  });

  test('edit-to-empty drops the line (== remove)', () => {
    const text = 'drafts/\nvendor/\n';
    const next = editPatternAt(parseOkignoreDoc(text), 0, '');
    expect(serializeOkignoreDoc(next)).toBe('vendor/\n');
  });

  test('edit-to-whitespace-only drops the line (== remove, defensive)', () => {
    const text = 'drafts/\nvendor/\n';
    const next = editPatternAt(parseOkignoreDoc(text), 0, '   ');
    expect(serializeOkignoreDoc(next)).toBe('vendor/\n');
  });

  test('out-of-range patternIndex returns the doc unchanged', () => {
    const original = parseOkignoreDoc('drafts/\n');
    expect(editPatternAt(original, 5, 'foo')).toBe(original);
    expect(editPatternAt(original, -1, 'foo')).toBe(original);
  });

  test('edit on the only pattern keeps the trailing newline', () => {
    const next = editPatternAt(parseOkignoreDoc('drafts/\n'), 0, 'vendor/');
    expect(serializeOkignoreDoc(next)).toBe('vendor/\n');
  });
});

describe('removePatternAt', () => {
  test('drops the n-th pattern line', () => {
    const next = removePatternAt(parseOkignoreDoc('a/\nb/\nc/\n'), 1);
    expect(serializeOkignoreDoc(next)).toBe('a/\nc/\n');
  });

  test('preserves comments around a removed pattern', () => {
    const text = '# Drafts\ndrafts/\n# After\nvendor/\n';
    const next = removePatternAt(parseOkignoreDoc(text), 0);
    expect(serializeOkignoreDoc(next)).toBe('# Drafts\n# After\nvendor/\n');
  });

  test('preserves blank lines around a removed pattern', () => {
    const text = '\ndrafts/\n\nvendor/\n';
    const next = removePatternAt(parseOkignoreDoc(text), 1);
    expect(serializeOkignoreDoc(next)).toBe('\ndrafts/\n\n');
  });

  test('out-of-range patternIndex returns the doc unchanged', () => {
    const original = parseOkignoreDoc('drafts/\n');
    expect(removePatternAt(original, 5)).toBe(original);
    expect(removePatternAt(original, -1)).toBe(original);
  });
});

describe('reorderPatterns', () => {
  test('moves pattern from to', () => {
    const next = reorderPatterns(parseOkignoreDoc('a/\nb/\nc/\n'), 0, 2);
    expect(serializeOkignoreDoc(next)).toBe('b/\nc/\na/\n');
  });

  test('moves pattern up the list', () => {
    const next = reorderPatterns(parseOkignoreDoc('a/\nb/\nc/\n'), 2, 0);
    expect(serializeOkignoreDoc(next)).toBe('c/\na/\nb/\n');
  });

  test('moving in place returns the doc unchanged', () => {
    const original = parseOkignoreDoc('a/\nb/\n');
    expect(reorderPatterns(original, 0, 0)).toBe(original);
    expect(reorderPatterns(original, 1, 1)).toBe(original);
  });

  test('comment + blank line positions are PRESERVED — patterns rotate through pattern slots', () => {
    // The user moved 'b/' to position 1 (was position 2). Comments at line 0
    // ("# A") and line 3 ("# B") stay where they are — they belong to the
    // SLOT in the source, not the pattern that happens to occupy it.
    const text = '# A\na/\n# B\nb/\nc/\n';
    const next = reorderPatterns(parseOkignoreDoc(text), 1, 0);
    expect(serializeOkignoreDoc(next)).toBe('# A\nb/\n# B\na/\nc/\n');
  });

  test('reorder preserves leading/trailing whitespace on pattern lines (raw travels with text)', () => {
    const text = '  drafts/  \nvendor/\n';
    const next = reorderPatterns(parseOkignoreDoc(text), 0, 1);
    // Patterns 0 and 1 swap places — the whitespace on the original line 0
    // travels with its pattern entry, not the slot.
    expect(serializeOkignoreDoc(next)).toBe('vendor/\n  drafts/  \n');
  });

  test('out-of-range from or to returns the doc unchanged', () => {
    const original = parseOkignoreDoc('a/\nb/\n');
    expect(reorderPatterns(original, 0, 5)).toBe(original);
    expect(reorderPatterns(original, 5, 0)).toBe(original);
    expect(reorderPatterns(original, -1, 1)).toBe(original);
  });

  test('reorder a single-pattern doc is a no-op', () => {
    const original = parseOkignoreDoc('only/\n');
    expect(reorderPatterns(original, 0, 0)).toBe(original);
  });
});

describe('compositional integrity', () => {
  test('append → edit → reorder → remove preserves comment positions', () => {
    let doc = parseOkignoreDoc('# Header\ndrafts/\n# Mid\nvendor/\n');
    doc = appendPattern(doc, '*.tmp');
    expect(serializeOkignoreDoc(doc)).toBe('# Header\ndrafts/\n# Mid\nvendor/\n*.tmp\n');
    doc = editPatternAt(doc, 1, 'lib/');
    expect(serializeOkignoreDoc(doc)).toBe('# Header\ndrafts/\n# Mid\nlib/\n*.tmp\n');
    doc = reorderPatterns(doc, 2, 0);
    // Three patterns: drafts, lib, *.tmp -> *.tmp first, then drafts, then lib.
    expect(serializeOkignoreDoc(doc)).toBe('# Header\n*.tmp\n# Mid\ndrafts/\nlib/\n');
    doc = removePatternAt(doc, 0);
    expect(serializeOkignoreDoc(doc)).toBe('# Header\n# Mid\ndrafts/\nlib/\n');
  });
});
