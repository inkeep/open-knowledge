import { describe, expect, test } from 'vitest';
import {
  containsConflictMarkers,
  containsUnresolvedConflictBlock,
  MAX_LCS_CELLS,
  reconcile,
  splitMarkdownBlocks,
} from './reconciliation';

describe('splitMarkdownBlocks', () => {
  test('splits on blank lines', () => {
    const blocks = splitMarkdownBlocks('# Heading\n\nParagraph one.\n\nParagraph two.\n');
    expect(blocks).toEqual(['# Heading', 'Paragraph one.', 'Paragraph two.']);
  });

  test('respects fenced code blocks', () => {
    const md = '# Title\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\nAfter code.\n';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks).toEqual(['# Title', '```js\nconst x = 1;\n\nconst y = 2;\n```', 'After code.']);
  });

  test('returns empty array for empty string', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
  });

  test('handles single block', () => {
    expect(splitMarkdownBlocks('# Just a heading\n')).toEqual(['# Just a heading']);
  });

  test('drops blank runs instead of emitting an empty block', () => {
    expect(splitMarkdownBlocks('a\n\n\n\nb')).toEqual(['a', 'b']);
    expect(splitMarkdownBlocks('A\n\n \n\nB')).toEqual(['A', 'B']);
    expect(splitMarkdownBlocks('\n\n\na')).toEqual(['a']);
  });
});

describe('containsConflictMarkers', () => {
  test('detects merge-style markers (<<<<<<< HEAD)', () => {
    const content = 'some text\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
    expect(containsConflictMarkers(content)).toBe(true);
  });

  test('detects diff3-style markers (||||||| base)', () => {
    const content =
      '<<<<<<< HEAD\nours\n||||||| merged common ancestors\nbase\n=======\ntheirs\n>>>>>>> branch\n';
    expect(containsConflictMarkers(content)).toBe(true);
  });

  test('detects zdiff3-style markers', () => {
    const content =
      '<<<<<<< HEAD\nours\n||||||| parent of abc123\nbase\n=======\ntheirs\n>>>>>>> abc123\n';
    expect(containsConflictMarkers(content)).toBe(true);
  });

  test('detects ======= on its own line', () => {
    const content = 'before\n=======\nafter\n';
    expect(containsConflictMarkers(content)).toBe(true);
  });

  test('does not match ======= inside a word', () => {
    const content = 'some ======= inline text\n';
    expect(containsConflictMarkers(content)).toBe(false);
  });

  test('returns false for normal markdown', () => {
    const content = '# Heading\n\nA normal paragraph.\n\n```js\ncode();\n```\n';
    expect(containsConflictMarkers(content)).toBe(false);
  });
});

describe('reconcile', () => {
  const docName = 'test-doc';

  test('noop: theirs equals base', () => {
    const base = '# Hello\n\nWorld.\n';
    const result = reconcile({ docName, base, ours: '# Hello\n\nEdited.\n', theirs: base });
    expect(result.kind).toBe('noop');
  });

  test('merged: an extra blank line on the disk side does not manufacture a conflict', () => {
    const result = reconcile({
      docName,
      base: 'A\n\nB\n',
      ours: 'A\n\nC\n',
      theirs: 'A\n\n\n\nC\n',
    });
    expect(result).toEqual({ kind: 'merged', newContent: 'A\n\nC\n', mergedBlocks: 2 });
  });

  test('clean: ours equals base (Y.Doc unchanged)', () => {
    const base = '# Hello\n\nWorld.\n';
    const theirs = '# Hello\n\nExternal edit.\n';
    const result = reconcile({ docName, base, ours: base, theirs });
    expect(result.kind).toBe('clean');
    if (result.kind === 'clean') {
      expect(result.newContent).toBe(theirs);
    }
  });

  test('refused: theirs contains conflict markers', () => {
    const base = '# Hello\n\nWorld.\n';
    const theirs = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
    const result = reconcile({ docName, base, ours: base, theirs });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toBe('conflict-markers');
    }
  });

  test('refused takes precedence over clean', () => {
    const base = '# Hello\n';
    const theirs = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
    const result = reconcile({ docName, base, ours: base, theirs });
    expect(result.kind).toBe('refused');
  });

  test('merged: non-overlapping changes from both sides', () => {
    const base = '# Title\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.\n';
    const ours = '# Title\n\nParagraph one EDITED.\n\nParagraph two.\n\nParagraph three.\n';
    const theirs = '# Title\n\nParagraph one.\n\nParagraph two.\n\nParagraph three EDITED.\n';

    const result = reconcile({ docName, base, ours, theirs });
    expect(result.kind).toBe('merged');
    if (result.kind === 'merged') {
      const blocks = splitMarkdownBlocks(result.newContent);
      expect(blocks).toContain('Paragraph one EDITED.');
      expect(blocks).toContain('Paragraph three EDITED.');
      expect(blocks).toContain('Paragraph two.');
    }
  });

  test('merged: theirs adds a new block, ours unchanged in that area', () => {
    const base = '# Title\n\nParagraph one.\n';
    const ours = '# Title\n\nParagraph one EDITED.\n';
    const theirs = '# Title\n\nParagraph one.\n\nNew paragraph from disk.\n';

    const result = reconcile({ docName, base, ours, theirs });
    expect(result.kind).toBe('merged');
    if (result.kind === 'merged') {
      const blocks = splitMarkdownBlocks(result.newContent);
      expect(blocks).toContain('Paragraph one EDITED.');
      expect(blocks).toContain('New paragraph from disk.');
    }
  });

  test('conflicts: both sides change the same block', () => {
    const base = '# Title\n\nShared paragraph.\n\nAnother paragraph.\n';
    const ours = '# Title\n\nOur version of shared.\n\nAnother paragraph.\n';
    const theirs = '# Title\n\nTheir version of shared.\n\nAnother paragraph.\n';

    const result = reconcile({ docName, base, ours, theirs });
    expect(result.kind).toBe('conflicts');
    if (result.kind === 'conflicts') {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].base).toBe('Shared paragraph.');
      expect(result.conflicts[0].ours).toBe('Our version of shared.');
      expect(result.conflicts[0].theirs).toBe('Their version of shared.');
      const blocks = splitMarkdownBlocks(result.newContent);
      expect(blocks).toContain('Our version of shared.');
    }
  });

  test('conflicts: mixed — some blocks conflict, others merge cleanly', () => {
    const base = '# Title\n\nBlock A.\n\nBlock B.\n\nBlock C.\n';
    const ours = '# Title\n\nBlock A edited by us.\n\nBlock B.\n\nBlock C edited by us.\n';
    const theirs = '# Title\n\nBlock A.\n\nBlock B edited by them.\n\nBlock C edited by them.\n';

    const result = reconcile({ docName, base, ours, theirs });
    expect(result.kind).toBe('conflicts');
    if (result.kind === 'conflicts') {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].base).toBe('Block C.');

      const blocks = splitMarkdownBlocks(result.newContent);
      expect(blocks).toContain('Block A edited by us.');
      expect(blocks).toContain('Block B edited by them.');
    }
  });

  test('merged: both sides converge to same edit (no conflict)', () => {
    const base = '# Title\n\nOld text.\n';
    const ours = '# Title\n\nNew text.\n';
    const theirs = '# Title\n\nNew text.\n';

    const result = reconcile({ docName, base, ours, theirs });
    expect(result.kind).toBe('merged');
  });

  function buildBlocks(prefix: string, count: number): string {
    const blocks: string[] = [];
    for (let i = 0; i < count; i++) blocks.push(`${prefix} ${i}.`);
    return `${blocks.join('\n\n')}\n`;
  }

  const overCapPerSide = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 10;

  test('refused: (base × ours) exceeds the LCS bound', () => {
    const base = buildBlocks('base', overCapPerSide);
    const ours = buildBlocks('ours', overCapPerSide);
    const theirs = '# Title\n\ntheirs unchanged-but-different.\n';

    const result = reconcile({ docName, base, ours, theirs });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toBe('too-large');
    }
  });

  test('refused: (base × theirs) exceeds the LCS bound', () => {
    const base = buildBlocks('base', overCapPerSide);
    const ours = '# Title\n\nours edit.\n';
    const theirs = buildBlocks('theirs', overCapPerSide);

    const result = reconcile({ docName, base, ours, theirs });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toBe('too-large');
    }
  });

  test('refused: oversized inputs return promptly without allocating LCS DP', () => {
    const base = buildBlocks('base', overCapPerSide);
    const ours = buildBlocks('ours', overCapPerSide);
    const theirs = buildBlocks('theirs', overCapPerSide);

    const start = performance.now();
    const result = reconcile({ docName, base, ours, theirs });
    const elapsed = performance.now() - start;

    expect(result.kind).toBe('refused');
    expect(elapsed).toBeLessThan(2000);
  });

  test('large but in-bounds inputs still merge', () => {
    const same = buildBlocks('block', 100);
    const base = same;
    const ours = `${same}\nAdded by us.\n`;
    const theirs = `${same}\nAdded by them.\n`;

    const result = reconcile({ docName, base, ours, theirs });
    expect(result.kind).toBe('merged');
    if (result.kind === 'merged') {
      const out = splitMarkdownBlocks(result.newContent);
      expect(out).toContain('Added by us.');
      expect(out).toContain('Added by them.');
    }
  });

  describe('empty base', () => {
    test('refused: identical non-empty sides are not concatenated (no-base)', () => {
      const content = '# SPEC\n\nSection one.\n\nSection two.\n';
      const result = reconcile({ docName: 'SPEC', base: '', ours: content, theirs: content });
      expect(result.kind).not.toBe('merged');
      expect(result.kind).toBe('refused');
      if (result.kind === 'refused') {
        expect(result.reason).toBe('no-base');
      }
    });

    test('refused: divergent non-empty sides are not concatenated (no-base)', () => {
      const ours = '# SPEC\n\nEditor heading.\n\nEditor paragraph.\n';
      const theirs = '# SPEC\n\nDisk heading.\n\nDisk paragraph.\n';
      const result = reconcile({ docName, base: '', ours, theirs });
      expect(result.kind).not.toBe('merged');
      expect(result.kind).toBe('refused');
      if (result.kind === 'refused') {
        expect(result.reason).toBe('no-base');
      }
    });

    test('refused: stale disk content against an edited doc is not concatenated (no-base)', () => {
      const staleDisk = '# SPEC\n\nSection one.\n\nSection two.\n';
      const edited = '# SPEC\n\nSection one.\n\nSection two edited locally.\n';
      const result = reconcile({ docName, base: '', ours: edited, theirs: staleDisk });
      expect(result.kind).not.toBe('merged');
      expect(result.kind).toBe('refused');
      if (result.kind === 'refused') {
        expect(result.reason).toBe('no-base');
      }
    });

    test('refused: whitespace-only base with both sides non-empty is not concatenated (no-base)', () => {
      const ours = '# A\n\nMine.\n';
      const theirs = '# A\n\nTheirs.\n';
      const result = reconcile({ docName, base: '\n \n', ours, theirs });
      expect(result.kind).not.toBe('merged');
      expect(result.kind).toBe('refused');
      if (result.kind === 'refused') {
        expect(result.reason).toBe('no-base');
      }
    });

    test('refused: a space-bearing whitespace base emits no content to apply (no-base)', () => {
      const ours = '# SPEC\n\nEditor one.\n\nEditor two.\n';
      const theirs = '# SPEC\n\nDisk one.\n\nDisk two.\n';
      const result = reconcile({ docName, base: '  \n\n  ', ours, theirs });

      expect(result.kind).toBe('refused');
      if (result.kind === 'refused') {
        expect(result.reason).toBe('no-base');
      }
      const appliedBlocks = 'newContent' in result ? splitMarkdownBlocks(result.newContent) : [];
      expect(appliedBlocks).toEqual([]);
    });

    test('clean: empty ours with empty base adopts theirs', () => {
      const theirs = '# SPEC\n\nDisk content.\n';
      const result = reconcile({ docName, base: '', ours: '', theirs });
      expect(result.kind).toBe('clean');
      if (result.kind === 'clean') {
        expect(result.newContent).toBe(theirs);
      }
    });

    test('noop: empty theirs with empty base keeps ours', () => {
      const ours = '# SPEC\n\nEditor content.\n';
      const result = reconcile({ docName, base: '', ours, theirs: '' });
      expect(result.kind).toBe('noop');
    });
  });

  describe('insert convergence with a real base', () => {
    test('merged: the same block inserted at the same anchor by both sides appears once', () => {
      const base = '# Title\n\nAnchor.\n\nTail.\n';
      const ours = '# Title\n\nAnchor.\n\nInserted by both.\n\nTail.\n';
      const theirs = '# Title\n\nAnchor.\n\nInserted by both.\n\nTail.\n';

      const result = reconcile({ docName, base, ours, theirs });
      expect(result.kind).toBe('merged');
      if (result.kind === 'merged') {
        const blocks = splitMarkdownBlocks(result.newContent);
        expect(blocks.filter((block) => block === 'Inserted by both.')).toHaveLength(1);
        expect(blocks).toContain('Anchor.');
        expect(blocks).toContain('Tail.');
      }
    });

    test('merged: the same block appended at the end by both sides appears once', () => {
      const base = '# Title\n\nTail.\n';
      const ours = '# Title\n\nTail.\n\nAppended by both.\n';
      const theirs = '# Title\n\nTail.\n\nAppended by both.\n';

      const result = reconcile({ docName, base, ours, theirs });
      expect(result.kind).toBe('merged');
      if (result.kind === 'merged') {
        const blocks = splitMarkdownBlocks(result.newContent);
        expect(blocks.filter((block) => block === 'Appended by both.')).toHaveLength(1);
        expect(blocks).toContain('Tail.');
      }
    });

    test("merged: theirs' insert order is preserved and the duplicated block appears once", () => {
      const base = 'Anchor.\n';
      const ours = 'Anchor.\n\nA.\n';
      const theirs = 'Anchor.\n\nB.\n\nA.\n';

      const result = reconcile({ docName, base, ours, theirs });
      expect(result.kind).toBe('merged');
      if (result.kind === 'merged') {
        expect(splitMarkdownBlocks(result.newContent)).toEqual(['Anchor.', 'B.', 'A.']);
      }
    });

    test('merged: insert groups past the LCS cap fall back to emitting every block from both sides', () => {
      const perSide = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 10;
      const shared = Array.from({ length: 10 }, (_, i) => `shared ${i}.`);
      const base = 'Anchor.\n';
      const ourBlocks = [...shared, ...Array.from({ length: perSide }, (_, i) => `ours ${i}.`)];
      const theirBlocks = [...shared, ...Array.from({ length: perSide }, (_, i) => `theirs ${i}.`)];
      const ours = `Anchor.\n\n${ourBlocks.join('\n\n')}`;
      const theirs = `Anchor.\n\n${theirBlocks.join('\n\n')}`;

      const result = reconcile({ docName, base, ours, theirs });
      expect(result.kind).toBe('merged');
      if (result.kind === 'merged') {
        expect(result.dedupSkipped).toBe(true);
        const blocks = new Set(splitMarkdownBlocks(result.newContent));
        for (let i = 0; i < perSide; i++) {
          expect(blocks.has(`ours ${i}.`)).toBe(true);
          expect(blocks.has(`theirs ${i}.`)).toBe(true);
        }
        for (const block of shared) {
          expect(blocks.has(block)).toBe(true);
        }
      }
    });

    test('conflicts: an outcome that also skipped dedup past the LCS cap reports dedupSkipped', () => {
      const perSide = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 10;
      const shared = Array.from({ length: 10 }, (_, i) => `shared ${i}.`);
      const base = 'Anchor.\n';
      const ourBlocks = [
        'Anchor edited by us.',
        ...shared,
        ...Array.from({ length: perSide }, (_, i) => `ours ${i}.`),
      ];
      const theirBlocks = [
        'Anchor edited by them.',
        ...shared,
        ...Array.from({ length: perSide }, (_, i) => `theirs ${i}.`),
      ];
      const ours = `${ourBlocks.join('\n\n')}\n`;
      const theirs = `${theirBlocks.join('\n\n')}\n`;

      const result = reconcile({ docName, base, ours, theirs });
      expect(result.kind).toBe('conflicts');
      if (result.kind === 'conflicts') {
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].ours).toBe('Anchor edited by us.');
        expect(result.conflicts[0].theirs).toBe('Anchor edited by them.');
        expect(result.dedupSkipped).toBe(true);
      }
    });
  });
  test('merged: two common blocks in one insert group keep their interleave position exactly once', () => {
    const outcome = reconcile({
      docName: 'SPEC',
      base: 'Anchor.\n',
      ours: 'Anchor.\n\nX.\n\nA.\n\nY.\n\nC.\n',
      theirs: 'Anchor.\n\nA.\n\nB.\n\nC.\n',
    });
    expect(outcome).toMatchObject({ kind: 'merged' });
    if (outcome.kind !== 'merged') return;
    expect(splitMarkdownBlocks(outcome.newContent)).toEqual([
      'Anchor.',
      'X.',
      'A.',
      'Y.',
      'B.',
      'C.',
    ]);
  });
});

describe('containsUnresolvedConflictBlock', () => {
  test('a complete unresolved block is detected', () => {
    expect(
      containsUnresolvedConflictBlock('<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n'),
    ).toBe(true);
  });

  test('a half-resolved file with one block left is detected', () => {
    expect(
      containsUnresolvedConflictBlock(
        'resolved prose\n\n<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n\ntail\n',
      ),
    ).toBe(true);
  });

  test('a setext H1 underline is not a conflict', () => {
    expect(containsUnresolvedConflictBlock('Release Notes\n=======\n\nWe shipped it.\n')).toBe(
      false,
    );
  });

  test('an end marker with no start is not a conflict', () => {
    expect(containsUnresolvedConflictBlock('prose\n>>>>>>> theirs\n')).toBe(false);
  });

  test('a start marker with no end is not a complete block', () => {
    expect(containsUnresolvedConflictBlock('<<<<<<< ours\nmine\n')).toBe(false);
  });

  test('the loose predicate still flags the setext heading it always did', () => {
    expect(containsConflictMarkers('Release Notes\n=======\n')).toBe(true);
  });
});
