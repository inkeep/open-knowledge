import { describe, expect, test } from 'vitest';
import { SkillFilePutRequestSchema } from './tags-search.ts';

const excludedCodePoints = Array.from({ length: 32 }, (_, code) => code).filter(
  (code) => ![9, 10, 13].includes(code),
);
const paths = ['references/admission.md', 'references/admission.mdx'] as const;
const allowed = '\tline\ncarriage\rreturn\r\nPrintable \\u0000 \\u001F 😀\u007f\u0080\u009f';
const request = (path: string, content: string, scope = 'project') => ({
  scope,
  name: 'admission',
  path,
  content,
});

describe.each(paths)('%s incoming Markdown file content', (path) => {
  test.each(excludedCodePoints)('rejects decoded C0 code point %i', (code) => {
    const result = SkillFilePutRequestSchema.safeParse(
      request(path, `x😀${String.fromCharCode(code)}private-tail`),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['content']);
    const message = result.error.issues.map((issue) => issue.message).join('\n');
    expect(message).toContain(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    expect(message).toMatch(/UTF-?16/i);
    expect(message).toMatch(/offset\D*3\b/i);
    expect(message).not.toContain('x😀');
    expect(message).not.toContain('private-tail');
    expect(message).not.toContain(String.fromCharCode(code));
  });

  test.each(['', allowed])('preserves admitted content bytes: %j', (content) => {
    expect(SkillFilePutRequestSchema.parse(request(path, content)).content).toBe(content);
  });

  test('reports sole NUL at offset zero and bounds non-echoing diagnostics', () => {
    for (const content of [
      '\u0000',
      `private-prefix${'x'.repeat(4096)}${'\u0000'.repeat(10_000)}`,
    ]) {
      const result = SkillFilePutRequestSchema.safeParse(request(path, content));
      expect.soft(result.success).toBe(false);
      if (result.success) continue;
      const message = result.error.issues.map((issue) => issue.message).join('\n');
      expect(message).toContain('U+0000');
      expect(message).toMatch(new RegExp(`offset\\D*${content.indexOf('\u0000')}\\b`, 'i'));
      expect(message.length).toBeLessThan(2048);
      expect(message).not.toContain('private-prefix');
      expect(message).not.toContain('\u0000');
    }
  });
});

test.each([
  ['project', 'references/admission.MD'],
  ['project', 'references/admission.MDX'],
  ['global', 'references/admission.md'],
  ['global', 'references/admission.mdx'],
  ['project', 'scripts/admission.md'],
  ['project', 'assets/admission.mdx'],
])(
  'rejects Markdown controls independently of scope, suffix case or file kind: %s %s',
  (scope, path) => {
    expect(SkillFilePutRequestSchema.safeParse(request(path, '\u0000\u001f', scope)).success).toBe(
      false,
    );
  },
);

test.each([
  'scripts/fixture.py',
  'assets/data.bin',
  'references/data.txt',
  'references/admission.md.bak',
])('keeps non-Markdown content opaque: %s', (path) => {
  const content = String.fromCharCode(...excludedCodePoints);
  expect(SkillFilePutRequestSchema.parse(request(path, content)).content).toBe(content);
});
