import { describe, expect, test } from 'bun:test';
import {
  containsConflictMarkers,
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
});
