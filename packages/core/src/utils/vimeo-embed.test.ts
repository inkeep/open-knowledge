import { describe, expect, test } from 'vitest';
import { isVimeoUrl } from './vimeo-embed.ts';

describe('isVimeoUrl', () => {
  test('accepts canonical vimeo.com URLs', () => {
    expect(isVimeoUrl('https://vimeo.com/76979871')).toBe(true);
    expect(isVimeoUrl('https://www.vimeo.com/76979871')).toBe(true);
  });

  test('accepts unlisted-hash URLs', () => {
    expect(isVimeoUrl('https://vimeo.com/76979871/abc123def4')).toBe(true);
  });

  test('accepts player.vimeo.com embed URLs', () => {
    expect(isVimeoUrl('https://player.vimeo.com/video/76979871')).toBe(true);
  });

  test('accepts channels / groups / showcase paths', () => {
    expect(isVimeoUrl('https://vimeo.com/channels/staffpicks/76979871')).toBe(true);
    expect(isVimeoUrl('https://vimeo.com/groups/motion/videos/76979871')).toBe(true);
    expect(isVimeoUrl('https://vimeo.com/showcase/12345/video/76979871')).toBe(true);
  });

  test('accepts URLs with `#t=` timestamps (lib handles them internally)', () => {
    expect(isVimeoUrl('https://vimeo.com/76979871#t=42s')).toBe(true);
  });

  test('rejects non-Vimeo hosts', () => {
    expect(isVimeoUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isVimeoUrl('https://example.com/video.mp4')).toBe(false);
  });

  test('rejects subdomain-spoofing hostnames', () => {
    expect(isVimeoUrl('https://vimeo.com.attacker.example/76979871')).toBe(false);
  });

  test('rejects non-http(s) schemes', () => {
    expect(isVimeoUrl('javascript:alert(1)')).toBe(false);
    expect(isVimeoUrl('data:video/mp4;base64,AAAA')).toBe(false);
  });

  test('rejects malformed URLs and empty input', () => {
    expect(isVimeoUrl('')).toBe(false);
    expect(isVimeoUrl('not a url')).toBe(false);
    // @ts-expect-error — runtime guard against non-string callers
    expect(isVimeoUrl(undefined)).toBe(false);
    // @ts-expect-error
    expect(isVimeoUrl(null)).toBe(false);
  });
});
