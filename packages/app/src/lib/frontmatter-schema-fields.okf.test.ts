/**
 * `schemaFieldsForDoc` over the OKF profile's schemas. The OKF plugin is a
 * second producer of governing frontmatter schemas — the sibling
 * `enumConstraintsForDoc` already folds `selectOkfFrontmatterSchemas` in, and
 * the field catalogue owes the add-property picker the same participation: a
 * staged row for the OKF-required `type` takes its widget type and required
 * hint from here.
 *
 * These exercise the REAL shipped OKF schemas rather than a stand-in, so a
 * change to the shipped contract fails here.
 */

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
    // Enabling OKF deliberately does not require enabling the frontmatter
    // plugin, so the picker must offer the profile's fields for a project
    // running OKF alone.
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: true }), 'notes/concept');

    const type = fields.get('type');
    expect(type?.required).toBe(true);
    // `type` is declared `type: string` with no date format → text widget.
    expect(type?.type).toBe('text');
    // The schema's agent-facing description is the picker's secondary text.
    expect(type?.description).toBeTruthy();

    // A recommended-family field keeps its declared widget shape too.
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

    // Both producers' fields are offered side by side.
    expect(fields.get('status')?.required).toBe(true);
    expect(fields.get('type')?.required).toBe(true);
  });

  test('respects the OKF profile scoping (a reserved index gets no concept fields)', () => {
    // A nested `index` is governed by the reserved-index schema (no properties),
    // not the concept schemas — the fold must go through the doc-scoped
    // selector, not blanket-add the whole registry.
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: true }), 'a/index');
    expect(fields.has('type')).toBe(false);
  });

  test('an OKF rule toggled off withdraws its fields', () => {
    const fields = schemaFieldsForDoc(
      configWithOkf({ enabled: true, rules: { 'frontmatter-required': false } }),
      'notes/concept',
    );
    expect(fields.has('type')).toBe(false);
    // The recommended family stays on independently.
    expect(fields.get('tags')?.type).toBe('list');
  });

  test('withholds the profile fields no widget can author conformantly', () => {
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: true }), 'notes/concept');

    // `sources` is an array of objects each requiring `resource`; the list
    // widget writes a flat string array, so committing one would be faulted by
    // the very schema that offered it.
    expect(fields.has('sources')).toBe(false);
    // Same shape in the attested-computation family.
    expect(fields.has('parameters')).toBe(false);
    // `verified` states two accepted shapes under `anyOf` and no top-level
    // type, so it would fall to the free-text widget and violate both.
    expect(fields.has('verified')).toBe(false);
  });

  test('still offers the profile fields a widget can author', () => {
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: true }), 'notes/concept');

    // An array of scalars is exactly what the list widget writes.
    expect(fields.get('tags')?.type).toBe('list');
    // Enum-only: no declared type, but the picker's vocabulary layer offers the
    // three values and free text accepts them.
    expect(fields.get('status')?.type).toBe('text');
    // Deliberately unconstrained by the profile, so nothing typed can violate it.
    expect(fields.get('timestamp')?.type).toBe('text');
    // An object field keeps the nested widget.
    expect(fields.get('generated')?.type).toBe('object');
  });

  test('a disabled OKF plugin contributes nothing', () => {
    const fields = schemaFieldsForDoc(configWithOkf({ enabled: false }), 'notes/concept');
    expect(fields.has('type')).toBe(false);
    expect(fields.has('tags')).toBe(false);
  });
});
