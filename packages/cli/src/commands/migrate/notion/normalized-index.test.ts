import { describe, expect, test } from 'vitest';
import { buildIndex, normalizeKey, resolveKey } from './normalized-index.ts';

const ID = '30545f35b5ad80a38049d283dae66763';

describe('normalizeKey', () => {
  test('folds an encoded, id-suffixed link target and its spaced filename to the same key', () => {
    const link = `Zendesk%20Integration%20Content%20Writer%20Agent%20${ID}.md`;
    const file = `Zendesk Integration Content Writer Agent ${ID}.md`;
    expect(normalizeKey(link)).toBe(normalizeKey(file));
    expect(normalizeKey(file)).toBe('zendesk integration content writer agent');
  });

  test('strips Notion-illegal punctuation kept in titles but not filenames', () => {
    expect(normalizeKey('What are the perils (today)?')).toBe('what are the perils today');
  });

  test('matches on the last path segment for relative links', () => {
    expect(normalizeKey(`../db/Content Plan ${ID}.md`)).toBe('content plan');
  });

  test('tolerates malformed percent-encoding without throwing', () => {
    expect(normalizeKey('bad%zzname.md')).toBe('bad%zzname');
  });
});

describe('buildIndex + resolveKey', () => {
  test('resolves an encoded id-suffixed link to its real file', () => {
    const file = `Foo Bar ${ID}.md`;
    const index = buildIndex([file, `Other ${ID}.md`]);
    const res = resolveKey(index, `Foo%20Bar%20${ID}.md`);
    expect(res).toEqual({ path: file, ambiguous: false });
  });

  test('reports ambiguity for duplicate titles and never guesses', () => {
    const a = `dir-a/Notes ${ID}.md`;
    const b = `dir-b/Notes ${'a'.repeat(32)}.md`;
    const index = buildIndex([a, b]);
    const res = resolveKey(index, 'Notes.md');
    expect(res.path).toBeNull();
    expect(res.ambiguous).toBe(true);
  });

  test('returns a null non-ambiguous resolution for a missing target', () => {
    const index = buildIndex([`Foo ${ID}.md`]);
    expect(resolveKey(index, 'Nope.md')).toEqual({ path: null, ambiguous: false });
  });
});
