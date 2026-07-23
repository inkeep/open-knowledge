import { Schema } from '@tiptap/pm/model';
import { describe, expect, test } from 'vitest';
import { findLiteralMatchesInDoc, findLiteralMatchesInText } from './literal-matcher';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
  },
});

function paragraphDoc(textRuns: ReadonlyArray<{ text: string; strong?: boolean }>) {
  return schema.node('doc', null, [
    schema.node(
      'paragraph',
      null,
      textRuns.map((run) =>
        schema.text(run.text, run.strong ? [schema.mark('strong')] : undefined),
      ),
    ),
  ]);
}

describe('findLiteralMatchesInText', () => {
  test('empty query returns no matches', () => {
    expect(
      findLiteralMatchesInText('alpha beta', '', {
        caseSensitive: false,
        wholeWord: false,
      }),
    ).toEqual([]);
  });

  test('literal matching finds all non-overlapping matches', () => {
    expect(
      findLiteralMatchesInText('aaaa', 'aa', {
        caseSensitive: false,
        wholeWord: false,
      }),
    ).toEqual([
      { start: 0, end: 2, text: 'aa' },
      { start: 2, end: 4, text: 'aa' },
    ]);
  });

  test('case-insensitive matching', () => {
    expect(
      findLiteralMatchesInText('Alpha alpha ALPHA', 'alpha', {
        caseSensitive: false,
        wholeWord: false,
      }).map((match) => match.text),
    ).toEqual(['Alpha', 'alpha', 'ALPHA']);
  });

  test('case-sensitive matching', () => {
    expect(
      findLiteralMatchesInText('Alpha alpha ALPHA', 'alpha', {
        caseSensitive: true,
        wholeWord: false,
      }).map((match) => match.text),
    ).toEqual(['alpha']);
  });

  test('whole-word matching uses ASCII word boundaries', () => {
    expect(
      findLiteralMatchesInText('cat catalog cat_cat cat.', 'cat', {
        caseSensitive: false,
        wholeWord: true,
      }).map((match) => match.start),
    ).toEqual([0, 20]);
  });
});

describe('findLiteralMatchesInDoc', () => {
  test('maps text-node offsets back to ProseMirror positions', () => {
    const doc = paragraphDoc([{ text: 'hello ' }, { text: 'hello', strong: true }]);
    expect(
      findLiteralMatchesInDoc(doc, 'hello', {
        caseSensitive: false,
        wholeWord: false,
      }),
    ).toEqual([
      { from: 1, to: 6, text: 'hello' },
      { from: 7, to: 12, text: 'hello' },
    ]);
  });

  test('v1 does not match across text node boundaries', () => {
    const doc = paragraphDoc([{ text: 'hel' }, { text: 'lo', strong: true }]);
    expect(
      findLiteralMatchesInDoc(doc, 'hello', {
        caseSensitive: false,
        wholeWord: false,
      }),
    ).toEqual([]);
  });
});
