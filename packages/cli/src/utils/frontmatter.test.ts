import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.ts';

describe('parseFrontmatter', () => {
  test('parses valid YAML frontmatter', () => {
    const content = '---\ntitle: Hello\ndescription: World\n---\n\nBody text.';
    const result = parseFrontmatter(content);
    expect(result).toEqual({ title: 'Hello', description: 'World' });
  });

  test('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('# Just a heading\n\nSome text.')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseFrontmatter('')).toBeNull();
  });

  test('returns null for malformed YAML', () => {
    const content = '---\n[invalid: yaml: : :\n---\n\nBody.';
    expect(parseFrontmatter(content)).toBeNull();
  });

  test('parses tags array', () => {
    const content = '---\ntitle: Test\ntags:\n  - auth\n  - sso\n---\n\nBody.';
    const result = parseFrontmatter(content);
    expect(result?.tags).toEqual(['auth', 'sso']);
  });

  test('handles frontmatter with no trailing newline after closing ---', () => {
    const content = '---\ntitle: Test\n---\nBody.';
    const result = parseFrontmatter(content);
    expect(result).toEqual({ title: 'Test' });
  });

  test('returns null when frontmatter YAML parses to a scalar', () => {
    const content = '---\njust a string\n---\n\nBody.';
    expect(parseFrontmatter(content)).toBeNull();
  });

  test('handles Windows line endings (\\r\\n)', () => {
    const content = '---\r\ntitle: Windows\r\n---\r\n\r\nBody.';
    const result = parseFrontmatter(content);
    expect(result).toEqual({ title: 'Windows' });
  });

  test('handles frontmatter at end of file (no trailing content)', () => {
    const content = '---\ntitle: EOF\n---';
    const result = parseFrontmatter(content);
    expect(result).toEqual({ title: 'EOF' });
  });

  test('validates and types with Zod schema', () => {
    const ArticleSchema = z.object({
      title: z.string(),
      description: z.string(),
      tags: z.array(z.string()).default([]),
    });
    const content = '---\ntitle: Auth\ndescription: How auth works\ntags:\n  - auth\n---\n\nBody.';
    const result = parseFrontmatter(content, ArticleSchema);
    expect(result).toEqual({ title: 'Auth', description: 'How auth works', tags: ['auth'] });
  });

  test('returns null when Zod schema validation fails', () => {
    const StrictSchema = z.object({
      title: z.string(),
      count: z.number(),
    });
    const content = '---\ntitle: Test\ncount: not-a-number\n---\n\nBody.';
    expect(parseFrontmatter(content, StrictSchema)).toBeNull();
  });

  test('parses frontmatter whose opening fence carries a trailing space', () => {
    // CommonMark / micromark-extension-frontmatter tolerate spaces/tabs
    // after the fence sequence; the CLI parser must agree, or a stray fence
    // keystroke makes the whole block invisible.
    const content = '--- \ntitle: Hello\ndescription: World\n---\n\nBody text.';
    expect(parseFrontmatter(content)).toEqual({ title: 'Hello', description: 'World' });
  });

  test('parses frontmatter whose closing fence carries a trailing tab', () => {
    const content = '---\ntitle: Hello\n---\t\n\nBody text.';
    expect(parseFrontmatter(content)).toEqual({ title: 'Hello' });
  });

  test('rejects leading whitespace before the opening fence', () => {
    expect(parseFrontmatter(' ---\ntitle: Not FM\n---\n\nBody.')).toBeNull();
  });

  test('Zod schema applies defaults for missing fields', () => {
    const WithDefaults = z.object({
      title: z.string(),
      status: z.string().default('draft'),
    });
    const content = '---\ntitle: Test\n---\n\nBody.';
    const result = parseFrontmatter(content, WithDefaults);
    expect(result).toEqual({ title: 'Test', status: 'draft' });
  });
});

describe('serializeFrontmatter', () => {
  test('produces valid frontmatter block with --- delimiters', () => {
    const result = serializeFrontmatter({ title: 'Hello', description: 'World' });
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\n---$/);
    expect(result).toContain('title: Hello');
    expect(result).toContain('description: World');
  });

  test('round-trips through parse', () => {
    const data = { title: 'Test', generated: true, schema_version: 1 };
    const serialized = `${serializeFrontmatter(data)}\n\nBody.`;
    const parsed = parseFrontmatter(serialized);
    expect(parsed?.title).toBe('Test');
    expect(parsed?.generated).toBe(true);
    expect(parsed?.schema_version).toBe(1);
  });
});
