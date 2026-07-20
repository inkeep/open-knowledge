import { describe, expect, test } from 'vitest';
import { parseFrontmatterRecord } from './record.ts';

describe('parseFrontmatterRecord', () => {
  test('parses valid YAML frontmatter into a record', () => {
    const content = '---\ntitle: Hello\ndescription: World\n---\n\nBody text.';
    expect(parseFrontmatterRecord(content)).toEqual({ title: 'Hello', description: 'World' });
  });

  test('returns null for content without a frontmatter block', () => {
    expect(parseFrontmatterRecord('# Just a heading\n\nSome text.')).toBeNull();
  });

  test('returns null for the empty string', () => {
    expect(parseFrontmatterRecord('')).toBeNull();
  });

  test('returns null for an empty frontmatter block', () => {
    expect(parseFrontmatterRecord('---\n---\n\nBody.')).toBeNull();
    expect(parseFrontmatterRecord('---\n---')).toBeNull();
  });

  test('returns null for malformed YAML', () => {
    const content = '---\n[invalid: yaml: : :\n---\n\nBody.';
    expect(parseFrontmatterRecord(content)).toBeNull();
  });

  test('returns null for duplicate keys (a YAML error)', () => {
    const content = '---\ntitle: One\ntitle: Two\n---\n\nBody.';
    expect(parseFrontmatterRecord(content)).toBeNull();
  });

  test('returns null when the YAML parses to a scalar', () => {
    expect(parseFrontmatterRecord('---\njust a string\n---\n\nBody.')).toBeNull();
  });

  test('returns null when the YAML parses to a sequence', () => {
    expect(parseFrontmatterRecord('---\n- a\n- b\n---\n\nBody.')).toBeNull();
  });

  test('parses block-style tag arrays', () => {
    const content = '---\ntitle: Test\ntags:\n  - auth\n  - sso\n---\n\nBody.';
    expect(parseFrontmatterRecord(content)?.tags).toEqual(['auth', 'sso']);
  });

  test('handles no trailing newline after the closing fence', () => {
    expect(parseFrontmatterRecord('---\ntitle: Test\n---\nBody.')).toEqual({ title: 'Test' });
  });

  test('handles frontmatter at end of file (no trailing content)', () => {
    expect(parseFrontmatterRecord('---\ntitle: EOF\n---')).toEqual({ title: 'EOF' });
  });

  test('handles Windows line endings (\\r\\n)', () => {
    const content = '---\r\ntitle: Windows\r\n---\r\n\r\nBody.';
    expect(parseFrontmatterRecord(content)).toEqual({ title: 'Windows' });
  });

  test('tolerates a trailing space on the opening fence', () => {
    // micromark-extension-frontmatter tolerates spaces/tabs after the fence
    // sequence; recognition here must agree with `FRONTMATTER_RE`, or a
    // stray fence keystroke makes the whole block invisible.
    const content = '--- \ntitle: Hello\ndescription: World\n---\n\nBody text.';
    expect(parseFrontmatterRecord(content)).toEqual({ title: 'Hello', description: 'World' });
  });

  test('tolerates a trailing tab on the closing fence', () => {
    const content = '---\ntitle: Hello\n---\t\n\nBody text.';
    expect(parseFrontmatterRecord(content)).toEqual({ title: 'Hello' });
  });

  test('rejects leading whitespace before the opening fence', () => {
    expect(parseFrontmatterRecord(' ---\ntitle: Not FM\n---\n\nBody.')).toBeNull();
  });

  test('keeps values verbatim: a bare key stays null', () => {
    // Contrast with `parseFrontmatterYaml`, whose map schema coerces a
    // bare-key null to '' — open-shape readers must see what the file said.
    expect(parseFrontmatterRecord('---\nbare:\n---\n\nBody.')).toEqual({ bare: null });
  });

  test('keeps values verbatim: mixed scalar arrays keep their types', () => {
    // Contrast with `parseFrontmatterYaml`, which stringifies scalar array
    // elements (['travel', '2026']).
    const content = '---\ntags: [travel, 2026]\n---\n\nBody.';
    expect(parseFrontmatterRecord(content)).toEqual({ tags: ['travel', 2026] });
  });

  test('returns null when toJS throws despite an error-free parse (unresolved alias)', () => {
    // Pins the catch guard: `parseDocument('foo: *nope')` reports zero
    // `doc.errors`, but `toJS()` throws "Unresolved alias". Circular anchors
    // do NOT throw (they yield a circular object), so this is the minimal
    // real input that reaches the catch.
    expect(parseFrontmatterRecord('---\nfoo: *nope\n---\n\nBody.')).toBeNull();
  });

  test('keeps nested mappings verbatim', () => {
    const content = '---\nicon:\n  url: https://example.com/img.png\n  alt: example\n---\n';
    expect(parseFrontmatterRecord(content)).toEqual({
      icon: { url: 'https://example.com/img.png', alt: 'example' },
    });
  });
});
