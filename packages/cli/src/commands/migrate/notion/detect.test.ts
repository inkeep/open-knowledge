import { describe, expect, test } from 'vitest';
import { isNotionExport } from './detect.ts';
import { makeTree } from './mktree.test-helper.ts';

const ID = '2a145f35b5ad808e9200ff850d964d8f';

describe('isNotionExport', () => {
  test('detects an id-suffixed markdown filename', () => {
    const root = makeTree({ [`Content Plan ${ID}.md`]: '# Content Plan\n' });
    expect(isNotionExport(root)).toBe(true);
  });

  test('detects a database _all.csv', () => {
    const root = makeTree({ [`Content Plan ${ID}_all.csv`]: 'a,b\n1,2\n' });
    expect(isNotionExport(root)).toBe(true);
  });

  test('detects an inline base64 image blob', () => {
    const root = makeTree({ 'page.md': '# P\n\n[](data:image/png;base64,iVBORw0KGgo=)\n' });
    expect(isNotionExport(root)).toBe(true);
  });

  test('returns false for an ordinary markdown directory', () => {
    const root = makeTree({ 'notes.md': '# Notes\n\nJust text.\n', 'readme.md': '# Readme\n' });
    expect(isNotionExport(root)).toBe(false);
  });

  test('ignores signals inside dot-directories', () => {
    const root = makeTree({ [`.ok/cache/x ${ID}.md`]: 'x', 'plain.md': '# plain\n' });
    expect(isNotionExport(root)).toBe(false);
  });
});
