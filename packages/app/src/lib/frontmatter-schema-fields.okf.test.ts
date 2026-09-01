import type { LinterConfig, OkfRuleId } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { schemaFieldsForDoc } from './frontmatter-schema-fields.ts';

function configWithOkf(
  okf: { enabled: boolean; rules?: Partial<Record<OkfRuleId, boolean>> },
  frontmatter: {
    enabled: boolean;
    schemas: { appliesTo?: string | string[]; file: string; schema?: Record<string, unknown> }[];
  } = { enabled: false, schemas: [] },
): LinterConfig {
  return {
    enabled: true,
    plugins: {
      markdownlint: { enabled: false, rules: {} },
      frontmatter,
      okf,
    },
  } as LinterConfig;
}

describe('schemaFieldsForDoc — the OKF profile', () => {
  test('OKF alone offers its declared fields, with the frontmatter plugin off', () => {
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: true }), 'notes/concept');

    const type = fields.get('type');
    expect(type?.required).toBe(true);
    expect(type?.type).toBe('text');
    expect(type?.description).toBeTruthy();

    expect(fields.get('tags')?.type).toBe('list');
    expect(fields.get('tags')?.required).toBe(false);
  });

  test('merges OKF fields with a user-authored schema governing the same doc', () => {
    const fields = schemaFieldsForDoc(
      configWithOkf(
        { enabled: true },
        {
          enabled: true,
          schemas: [
            {
              appliesTo: 'notes/**',
              file: 'notes.json',
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string' } },
              },
            },
          ],
        },
      ),
      'notes/concept',
    );

    expect(fields.get('status')?.required).toBe(true);
    expect(fields.get('type')?.required).toBe(true);
  });

  test('respects the OKF profile scoping (a reserved index gets no concept fields)', () => {
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: true }), 'a/index');
    expect(fields.has('type')).toBe(false);
  });

  test('an OKF rule toggled off withdraws its fields', () => {
    const fields = schemaFieldsForDoc(
      configWithOkf({ enabled: true, rules: { 'frontmatter-required': false } }),
      'notes/concept',
    );
    expect(fields.has('type')).toBe(false);
    expect(fields.get('tags')?.type).toBe('list');
  });

  test('withholds the profile fields no widget can author conformantly', () => {
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: true }), 'notes/concept');

    expect(fields.has('sources')).toBe(false);
    expect(fields.has('parameters')).toBe(false);
    expect(fields.has('verified')).toBe(false);
  });

  test('still offers the profile fields a widget can author', () => {
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: true }), 'notes/concept');

    expect(fields.get('tags')?.type).toBe('list');
    expect(fields.get('status')?.type).toBe('text');
    expect(fields.get('timestamp')?.type).toBe('text');
    expect(fields.get('generated')?.type).toBe('object');
  });

  test('a disabled OKF plugin contributes nothing', () => {
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: false }), 'notes/concept');
    expect(fields.has('type')).toBe(false);
    expect(fields.has('tags')).toBe(false);
  });
});
