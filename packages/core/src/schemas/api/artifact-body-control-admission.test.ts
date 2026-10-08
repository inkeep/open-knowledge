import { describe, expect, test } from 'vitest';
import {
  SkillMoveRequestSchema,
  SkillPutRequestSchema,
  TemplateMoveRequestSchema,
  TemplatePutRequestSchema,
} from './tags-search.ts';

const excludedCodePoints = Array.from({ length: 32 }, (_, code) => code).filter(
  (code) => ![9, 10, 13].includes(code),
);
const fields = [
  {
    label: 'TemplatePutRequestSchema',
    schema: TemplatePutRequestSchema,
    request: { folder: '', name: 'meeting' },
  },
  {
    label: 'TemplateMoveRequestSchema',
    schema: TemplateMoveRequestSchema,
    request: { fromFolder: '', fromName: 'meeting', toFolder: '', toName: 'renamed' },
  },
  {
    label: 'SkillPutRequestSchema',
    schema: SkillPutRequestSchema,
    request: { name: 'review', frontmatter: { name: 'review', description: 'Review code' } },
  },
  {
    label: 'SkillMoveRequestSchema',
    schema: SkillMoveRequestSchema,
    request: { scope: 'project', fromName: 'review', toName: 'renamed' },
  },
] as const;
const allowed = '\tline\ncarriage\rreturn\r\nPrintable \\u0000 \\u001F \\x00 😀\u007f\u0080\u009f';

describe.each(fields)('$label incoming body admission', ({ schema, request }) => {
  test.each(excludedCodePoints)('rejects decoded C0 code point %i', (code) => {
    const body = `x😀${String.fromCharCode(code)}private-tail`;
    const result = schema.safeParse({ ...request, body });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['body']);
    const message = result.error.issues.map((issue) => issue.message).join('\n');
    expect(message).toContain(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    expect(message).toMatch(/UTF-?16/i);
    expect(message).toMatch(/offset\D*3\b/i);
    expect(message).not.toContain('x😀');
    expect(message).not.toContain('private-tail');
    expect(message).not.toContain(String.fromCharCode(code));
  });

  test.each(['', allowed])('preserves admitted body bytes: %j', (body) => {
    expect(schema.parse({ ...request, body }).body).toBe(body);
  });

  test('keeps omitted body valid for metadata-only moves and writes', () => {
    expect(schema.parse(request).body).toBeUndefined();
  });

  test('reports a sole NUL at offset zero and bounds long non-echoing diagnostics', () => {
    for (const body of ['\u0000', `private-prefix${'x'.repeat(4096)}${'\u0000'.repeat(10_000)}`]) {
      const result = schema.safeParse({ ...request, body });
      expect.soft(result.success).toBe(false);
      if (result.success) continue;
      const messages = result.error.issues.map((issue) => issue.message).join('\n');
      expect(messages).toContain('U+0000');
      expect(messages).toMatch(new RegExp(`offset\\D*${body.indexOf('\u0000')}\\b`, 'i'));
      expect(messages.length).toBeLessThan(2048);
      expect(messages).not.toContain('private-prefix');
      expect(messages).not.toContain('\u0000');
    }
  });
});
