import { describe, expect, test } from 'vitest';
import { sanitizeGitIdentity } from './git-identity-sanitize.ts';

describe('sanitizeGitIdentity', () => {
  test('strips angle brackets', () => {
    expect(sanitizeGitIdentity('<Alice <evil>>')).toBe('Alice evil');
  });

  test('strips CR and LF', () => {
    expect(sanitizeGitIdentity('Alice\r\nSmith')).toBe('AliceSmith');
  });

  test('trims whitespace', () => {
    expect(sanitizeGitIdentity('  Alice  ')).toBe('Alice');
  });

  test('slices to 128 chars', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeGitIdentity(long)).toHaveLength(128);
  });

  test('leaves clean strings unchanged', () => {
    expect(sanitizeGitIdentity('alice@example.com')).toBe('alice@example.com');
  });

  test('empty string → empty string', () => {
    expect(sanitizeGitIdentity('')).toBe('');
  });

  test('strips all dangerous chars in combination', () => {
    expect(sanitizeGitIdentity('  <Bob>\r\n  ')).toBe('Bob');
  });
});
