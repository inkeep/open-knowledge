import { describe, expect, test } from 'vitest';
import { parseBranchList } from './branch-list-parser.ts';

describe('parseBranchList', () => {
  test('empty stdout yields empty array', () => {
    expect(parseBranchList('')).toEqual([]);
    expect(parseBranchList('\n\n')).toEqual([]);
  });

  test('parses one branch per line, preserving order', () => {
    expect(parseBranchList('main\nfeat/foo\nrelease-1\n')).toEqual([
      'main',
      'feat/foo',
      'release-1',
    ]);
  });

  test('tolerates missing trailing newline, CRLF, and surrounding whitespace', () => {
    expect(parseBranchList('main\r\n  feat/bar  ')).toEqual(['main', 'feat/bar']);
  });

  test('drops blank lines and de-duplicates', () => {
    expect(parseBranchList('main\n\nmain\ndev\n')).toEqual(['main', 'dev']);
  });

  test('keeps slash-namespaced branch names intact', () => {
    expect(parseBranchList('feat/a/b\nfix/c')).toEqual(['feat/a/b', 'fix/c']);
  });
});
