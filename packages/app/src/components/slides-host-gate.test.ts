import { describe, expect, test } from 'vitest';
import { isSlidesHost } from './slides-host-gate';

describe('isSlidesHost', () => {
  test('a desktop bridge exposing the slides namespace is a slides host', () => {
    expect(isSlidesHost({ okDesktop: { slides: {} } })).toBe(true);
  });

  test('an older desktop build without the slides namespace is not a slides host', () => {
    expect(isSlidesHost({ okDesktop: {} })).toBe(false);
  });

  test('a web host with no bridge is not a slides host', () => {
    expect(isSlidesHost({})).toBe(false);
  });

  test('an absent window (SSR) is not a slides host', () => {
    expect(isSlidesHost(undefined)).toBe(false);
  });
});
