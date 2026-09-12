import { describe, expect, test } from 'vitest';
import { docStem, isReservedLogDoc, RESERVED_LOG_STEM } from './reserved-docs.ts';

describe('isReservedLogDoc', () => {
  test('matches the exact lowercase reserved log at the root', () => {
    expect(isReservedLogDoc('log')).toBe(true);
    expect(isReservedLogDoc('log.md')).toBe(true);
    expect(isReservedLogDoc('log.mdx')).toBe(true);
  });

  test('matches the reserved log at any directory depth', () => {
    expect(isReservedLogDoc('notes/log')).toBe(true);
    expect(isReservedLogDoc('notes/log.md')).toBe(true);
    expect(isReservedLogDoc('a/b/c/log.mdx')).toBe(true);
  });

  test('does not match uppercase or mixed-case STEM spellings', () => {
    for (const name of ['LOG', 'LOG.md', 'Log.md', 'lOg.mdx', 'notes/LOG.md', 'notes/Log']) {
      expect(isReservedLogDoc(name)).toBe(false);
    }
  });

  test('matches a mixed-case EXTENSION, which the doc-file gate also folds', () => {
    for (const name of ['log.MD', 'log.Md', 'log.MDX', 'notes/log.MDX']) {
      expect(isReservedLogDoc(name)).toBe(true);
    }
  });

  test('does not match a stem that merely contains the reserved word', () => {
    for (const name of ['catalog.md', 'log-2026.md', 'changelog', 'notes/catalog.mdx']) {
      expect(isReservedLogDoc(name)).toBe(false);
    }
  });

  test('does not match a non-Markdown file named log', () => {
    for (const name of ['log.txt', 'log.json', 'notes/log.png']) {
      expect(isReservedLogDoc(name)).toBe(false);
    }
  });

  test('does not match a folder segment named log', () => {
    expect(isReservedLogDoc('log/entries.md')).toBe(false);
  });
});

describe('docStem', () => {
  test('strips only supported doc extensions', () => {
    expect(docStem('log.md')).toBe('log');
    expect(docStem('log.mdx')).toBe('log');
    expect(docStem('log.txt')).toBe('log.txt');
  });

  test('reads the final path segment', () => {
    expect(docStem('a/b/notes.md')).toBe('notes');
    expect(docStem('a.md/b')).toBe('b');
  });

  test('leaves a dotfile intact', () => {
    expect(docStem('.md')).toBe('.md');
  });

  test('strips an uppercase spelling of a supported extension', () => {
    expect(docStem('LOG.MD')).toBe('LOG');
  });
});

test('the reserved stem is the lowercase spelling the format recognizes', () => {
  expect(RESERVED_LOG_STEM).toBe('log');
});
