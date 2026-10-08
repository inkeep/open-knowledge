import { describe, expect, test } from 'vitest';
import { SkillFilePutRequestSchema } from './tags-search.ts';

const aliases = [
  'references/notes.md/',
  'references/notes.md/.',
  'references\\notes.md\\',
  'references//./notes.MDX/./',
] as const;
const allowed = '\tline\ncarriage\rreturn\\u0000 😀\u007f\u0080\u009f';
const request = (path: string, content: string) => ({
  name: 'alias-admission',
  path,
  content,
});

describe.each(aliases)('%s normalized Markdown admission', (path) => {
  test.each([0, 31])('refuses decoded C0 %i in content', (code) => {
    const result = SkillFilePutRequestSchema.safeParse(
      request(path, `x😀${String.fromCharCode(code)}private-tail`),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['content']);
    const detail = result.error.issues.map((issue) => issue.message).join('\n');
    expect(detail).toContain(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    expect(detail).toMatch(/UTF-?16.*offset\D*3\b/i);
    expect(detail).not.toContain('private-tail');
  });

  test('keeps previously accepted aliases and admitted bytes', () => {
    expect(SkillFilePutRequestSchema.parse(request(path, allowed)).content).toBe(allowed);
  });
});

test.each(['scripts/fixture.sh/.', 'assets/fixture.svg/', 'references/notes.md.bak/'])(
  'keeps normalized non-Markdown content opaque: %s',
  (path) => {
    const content = 'opaque\u0000\u001f';
    expect(SkillFilePutRequestSchema.parse(request(path, content)).content).toBe(content);
  },
);
