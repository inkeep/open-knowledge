import { describe, expect, test } from 'vitest';
// Leaf modules, not the `_helpers` barrel: the barrel re-exports
// Playwright-dependent helpers, which do not load under vitest.
import { escapeRegExp } from '../stress/_helpers/regexp.ts';
import { uniqueAssetName } from '../stress/_helpers/upload-fixtures.ts';

describe('uniqueAssetName', () => {
  test('inserts the runId before the final extension', () => {
    expect(uniqueAssetName('shot.png', 'abc12345')).toBe('shot-abc12345.png');
  });

  test('appends the runId when the filename has no extension', () => {
    expect(uniqueAssetName('README', 'abc12345')).toBe('README-abc12345');
  });

  test('salts before only the last extension segment of a multi-dot name', () => {
    expect(uniqueAssetName('archive.tar.gz', 'abc12345')).toBe('archive.tar-abc12345.gz');
  });
});

describe('escapeRegExp', () => {
  test('an escaped dot matches only a literal dot', () => {
    const re = new RegExp(`^${escapeRegExp('shot-abc.png')}$`);
    expect(re.test('shot-abc.png')).toBe(true);
    expect(re.test('shot-abcXpng')).toBe(false);
  });

  // Asserting only that the escaped pattern matches the string it was built
  // from is a tautology for the characters that matter: an unescaped `.`
  // still matches its own literal `.`, so the regression this helper exists
  // to prevent would pass. Each metacharacter is probed with a NEAR-MISS —
  // a string that differs only where the unescaped form would have matched
  // anyway — so a dropped escape fails.
  test.each([
    ['.', 'a.b', 'aXb'],
    ['*', 'ab*', 'abbb'],
    ['+', 'ab+', 'abb'],
    ['?', 'ab?', 'a'],
    ['^', 'a^b', 'ab'],
    ['$', 'a$b', 'ab'],
    ['{}', 'a{2}', 'aa'],
    ['()', 'a(b)', 'ab'],
    ['|', 'a|b', 'a'],
    ['[]', 'a[bc]', 'ab'],
    ['\\', 'a\\db', 'a5b'],
  ])('escapes %s so the pattern is literal, not a matcher', (_name, raw, nearMiss) => {
    const re = new RegExp(`^${escapeRegExp(raw)}$`);
    expect(re.test(raw)).toBe(true);
    expect(re.test(nearMiss)).toBe(false);
  });
});
