import { ClipPayloadSchema } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { resolveNonCollidingFilename, sanitizeClipFilename } from './clip-intake.ts';
import { parseClipUrl } from './url-scheme.ts';

describe('parseClipUrl', () => {
  test('parses a valid clip intake URL', () => {
    const parsed = parseClipUrl('openknowledge://clip?destination=default_inbox&clipboard=true');
    expect(parsed).toEqual({
      host: 'clip',
      destination: 'default_inbox',
      clipboard: true,
    });
  });

  test('rejects missing destination', () => {
    expect(parseClipUrl('openknowledge://clip?clipboard=true')).toBeNull();
  });

  test('rejects null bytes', () => {
    expect(parseClipUrl('openknowledge://clip?destination=inbox%00bad&clipboard=true')).toBeNull();
    expect(parseClipUrl('openknowledge://clip?destination=inbox\x00bad&clipboard=true')).toBeNull();
  });

  test('rejects path traversal in destination ID', () => {
    expect(parseClipUrl('openknowledge://clip?destination=../etc/passwd&clipboard=true')).toBeNull();
  });

  test('rejects invalid scheme or host', () => {
    expect(parseClipUrl('https://clip?destination=inbox')).toBeNull();
    expect(parseClipUrl('openknowledge://open?destination=inbox')).toBeNull();
  });
});

describe('ClipPayloadSchema', () => {
  test('validates openknowledge.clip/v1 envelope', () => {
    const payload = {
      schema: 'openknowledge.clip/v1',
      title: 'Test Article',
      suggestedFilename: 'test-article.md',
      sourceUrl: 'https://example.com/test',
      selectionOnly: false,
      markdown: '# Test Article\n\nContent...',
      metadata: { author: 'Alice' },
    };

    const parsed = ClipPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  test('rejects wrong schema version', () => {
    const payload = {
      schema: 'openknowledge.clip/v2',
      title: 'Test Article',
      sourceUrl: 'https://example.com/test',
      markdown: 'Content',
    };

    const parsed = ClipPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });
});

describe('clip-intake filename sanitization and collision resolution', () => {
  test('sanitizes titles into clean .md filenames', () => {
    expect(sanitizeClipFilename('My Article', '')).toBe('My Article.md');
    expect(sanitizeClipFilename(undefined, 'Raw Title: With Special Chars?')).toBe(
      'Raw Title- With Special Chars-.md',
    );
    expect(sanitizeClipFilename('../../etc/passwd')).toBe('passwd.md');
  });

  test('resolves non-colliding filenames ("Keep both")', () => {
    const existing = new Set(['article.md', 'article-1.md']);
    expect(resolveNonCollidingFilename(existing, 'article.md')).toBe('article-2.md');
    expect(resolveNonCollidingFilename(existing, 'new-article.md')).toBe('new-article.md');
  });
});
