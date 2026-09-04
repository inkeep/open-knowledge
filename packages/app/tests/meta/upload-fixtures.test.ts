import { describe, expect, test } from 'vitest';
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
