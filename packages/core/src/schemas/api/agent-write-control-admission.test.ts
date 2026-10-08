import { describe, expect, test } from 'vitest';
import {
  AgentPatchRequestSchema,
  AgentWriteBatchEntrySchema,
  AgentWriteBatchRequestSchema,
  AgentWriteMdRequestSchema,
  AgentWriteRequestSchema,
} from './agent-write.ts';

const excludedCodePoints = Array.from({ length: 32 }, (_, code) => code).filter(
  (code) => ![9, 10, 13].includes(code),
);
const fields = [
  { label: 'AgentWriteRequestSchema', name: 'content', schema: AgentWriteRequestSchema, body: {} },
  {
    label: 'AgentWriteMdRequestSchema',
    name: 'markdown',
    schema: AgentWriteMdRequestSchema,
    body: {},
  },
  {
    label: 'AgentPatchRequestSchema',
    name: 'replace',
    schema: AgentPatchRequestSchema,
    body: { find: 'old' },
  },
  {
    label: 'AgentWriteBatchEntrySchema',
    name: 'markdown',
    schema: AgentWriteBatchEntrySchema,
    body: { docName: 'note' },
  },
] as const;

describe.each(fields)('$label new $name admission', ({ name, schema, body }) => {
  test('rejects leading and sole U+0000 at UTF-16 offset 0 without echoing input', () => {
    for (const text of ['\u0000', '\u0000sensitive-tail😀']) {
      const result = schema.safeParse({ ...body, [name]: text });
      expect.soft(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual([name]);
      const message = result.error.issues.map((issue) => issue.message).join('\n');
      expect(message).toContain('U+0000');
      expect(message).toMatch(/UTF-?16/i);
      expect(message).toMatch(/offset\D*0\b/i);
      expect(message).not.toContain('\u0000');
      expect(message).not.toContain('sensitive-tail😀');
    }
  });

  test.each(excludedCodePoints)('rejects decoded C0 code point %i', (code) => {
    const result = schema.safeParse({ ...body, [name]: `x😀${String.fromCharCode(code)}tail` });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual([name]);
    const message = result.error.issues.map((issue) => issue.message).join('\n');
    expect(message).toContain(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    expect(message).toMatch(/UTF-?16/i);
    expect(message).toMatch(/offset\D*3\b/i);
    expect(message).not.toContain('x😀');
    expect(message).not.toContain('tail');
    expect(message).not.toContain(String.fromCharCode(code));
  });

  test.each([
    '',
    'Printable \\u0000 \\u001F \\x00',
    '\tline\ncarriage\rreturn\r\n',
    String.fromCharCode(...Array.from({ length: 33 }, (_, n) => 127 + n)),
    '😀 combining é and 日本語',
  ])('accepts allowed text without altering its bytes: %j', (text) => {
    const result = schema.safeParse({ ...body, [name]: text });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[name as keyof typeof result.data]).toBe(text);
  });

  test('bounds diagnostics without echoing long sensitive input', () => {
    const secret = 'sensitive-document-body-'.repeat(200);
    const result = schema.safeParse({
      ...body,
      [name]: `${secret}${String.fromCharCode(0).repeat(10_000)}`,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const diagnostics = JSON.stringify(result.error.issues);
    expect(diagnostics.length).toBeLessThan(2048);
    expect(diagnostics).toContain('U+0000');
    expect(diagnostics).not.toContain('sensitive-document-body');
  });
});

test('patch find remains able to match every excluded code point in existing source', () => {
  for (const code of excludedCodePoints) {
    const find = String.fromCharCode(code);
    expect(AgentPatchRequestSchema.parse({ find, replace: '\\u0000' }).find).toBe(find);
  }
});

test('mixed batch rejects the unsafe entry with an indexed field path', () => {
  const result = AgentWriteBatchRequestSchema.safeParse({
    docs: [
      { docName: 'clean', markdown: '# Clean\n' },
      { docName: 'unsafe', markdown: `x${String.fromCharCode(31)}` },
    ],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.path)).toContainEqual(['docs', 1, 'markdown']);
});
