/**
 * Schema-level regression coverage for `TemplatePayloadSchema.scope` and
 * `TemplateGetSuccessSchema` frontmatter shape.
 */

import { describe, expect, test } from 'bun:test';
import { TemplateGetSuccessSchema, TemplatePayloadSchema } from './tags-search.ts';

const validPayload = (scope: 'local' | 'inherited') => ({
  name: 'daily-journal',
  folder: 'notes',
  scope,
  path: 'notes/.ok/templates/daily-journal.md',
  frontmatter: { title: '{{date}}' },
  body: '## Morning\n',
});

describe('TemplatePayloadSchema.scope', () => {
  test.each(['local', 'inherited'] as const)('accepts scope=%s', (scope) => {
    const result = TemplatePayloadSchema.safeParse(validPayload(scope));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe(scope);
    }
  });

  test('rejects unknown scope value', () => {
    const result = TemplatePayloadSchema.safeParse({
      ...validPayload('local'),
      scope: 'global',
    });
    expect(result.success).toBe(false);
  });

  test("rejects scope='user' (user-tier removed)", () => {
    const result = TemplatePayloadSchema.safeParse({
      ...validPayload('local'),
      scope: 'user',
    });
    expect(result.success).toBe(false);
  });
});

describe('TemplateGetSuccessSchema', () => {
  test('frontmatter accepts free-form unknown values', () => {
    // Defensive: even if YAML parsing produces a weird (object-valued) field,
    // the schema must accept it — frontmatter is `z.record(z.string(),
    // z.unknown())` by design.
    const result = TemplateGetSuccessSchema.safeParse({
      template: {
        ...validPayload('local'),
        frontmatter: { title: { '{ date }': null }, tags: ['x'] },
      },
    });
    expect(result.success).toBe(true);
  });
});
