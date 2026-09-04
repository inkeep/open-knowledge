import { describe, expect, test } from 'vitest';
import { parseSignInOutput, shortenUrl } from './sign-in-output';

describe('parseSignInOutput', () => {
  test('pulls the code and URL out of a device-code flow', () => {
    const parsed = parseSignInOutput([
      '[acp/auth] Starting OAuth login for cline…',
      '[acp/auth] Enter this code in your browser: CRQT-NXNT',
      '[acp/auth] https://authkit.cline.bot/device?user_code=CRQT-NXNT',
    ]);

    expect(parsed.code).toBe('CRQT-NXNT');
    expect(parsed.url).toBe('https://authkit.cline.bot/device?user_code=CRQT-NXNT');
    expect(parsed.lines).toEqual(['Starting OAuth login for cline…']);
  });

  test('prefers the code carried in the URL', () => {
    const parsed = parseSignInOutput([
      'Type ABCD-EFGH if prompted',
      'https://example.test/device?user_code=WDJB-MJHT',
    ]);

    expect(parsed.code).toBe('WDJB-MJHT');
  });

  test('hands back anything it does not understand', () => {
    const parsed = parseSignInOutput(['[auth] check your email', 'we sent a magic link']);

    expect(parsed.code).toBeUndefined();
    expect(parsed.url).toBeUndefined();
    expect(parsed.lines).toEqual(['check your email', 'we sent a magic link']);
  });

  test('does not invent a code out of prose', () => {
    expect(parseSignInOutput(['Opening your browser to finish signing in']).code).toBeUndefined();
    expect(parseSignInOutput(['ERROR: token expired']).code).toBeUndefined();
  });

  test('drops empty lines and logging tags', () => {
    expect(parseSignInOutput(['', '   ', '[acp/auth]   spaced  ']).lines).toEqual(['spaced']);
  });

  test('trims trailing punctuation off a URL', () => {
    expect(parseSignInOutput(['visit https://example.test/device.']).url).toBe(
      'https://example.test/device',
    );
  });
});

describe('shortenUrl', () => {
  test('keeps host and path, drops scheme and query', () => {
    expect(shortenUrl('https://authkit.cline.bot/device?user_code=CRQT-NXNT')).toBe(
      'authkit.cline.bot/device',
    );
    expect(shortenUrl('https://example.test/')).toBe('example.test');
  });

  test('passes through anything that is not a URL', () => {
    expect(shortenUrl('not a url')).toBe('not a url');
  });
});
