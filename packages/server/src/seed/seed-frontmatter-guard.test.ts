/**
 * Regression guard: every frontmatter block shipped in a starter pack must be
 * valid YAML, and every template must be a single-block file.
 *
 * Why this exists: an unquoted colon in a frontmatter value (`description: do
 * work: now`) parses as a nested mapping and throws "mapping values are not
 * allowed here", which breaks the property-panel parse and the render. A
 * second stacked frontmatter block (the legacy two-block template format) leaks
 * into the rendered editor body. Both shipped at least once; this test fails
 * loud in CI rather than relying on review to catch the next one.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseTemplateFile,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import { STARTER_PACKS } from './starter.ts';

/**
 * Return a YAML *syntax* error for the frontmatter block, or null. This guards
 * parseability (what an unquoted colon breaks), NOT schema conformance — a
 * template legitimately carries `source_url:` (null) and `created: {{date}}`,
 * which are valid YAML but not valid doc-frontmatter values. `logLevel:
 * 'silent'` suppresses the benign `{{date}}` flow-map warning.
 */
function frontmatterParseError(content: string): string | null {
  const { frontmatter } = stripFrontmatter(content);
  if (frontmatter === '') return null;
  try {
    parseYaml(unwrapFrontmatterFences(frontmatter), { logLevel: 'silent' });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.split('\n')[0] : String(e);
  }
}

describe('starter-pack frontmatter guard', () => {
  test('every template frontmatter block is valid YAML', () => {
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const [name, content] of Object.entries(pack.templates)) {
        expect(
          frontmatterParseError(content),
          `Pack "${pack.id}" template "${name}" has invalid YAML frontmatter`,
        ).toBeNull();
      }
    }
  });

  test('every root-file frontmatter block is valid YAML', () => {
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const [name, content] of Object.entries(pack.rootFiles ?? {})) {
        expect(
          frontmatterParseError(content),
          `Pack "${pack.id}" rootFile "${name}" has invalid YAML frontmatter`,
        ).toBeNull();
      }
    }
  });

  test('every template is a SINGLE-block file (no stacked frontmatter)', () => {
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const [name, content] of Object.entries(pack.templates)) {
        // A stacked second block manifests as a `---\n---` fence junction.
        expect(
          /\n---\n---\n/.test(content),
          `Pack "${pack.id}" template "${name}" still has a stacked second frontmatter block`,
        ).toBe(false);
      }
    }
  });

  test('every template carries a non-empty identity title under template:', () => {
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const [name, content] of Object.entries(pack.templates)) {
        const { identity, starterContent } = parseTemplateFile(content);
        expect(
          typeof identity.title === 'string' && identity.title.trim().length > 0,
          `Pack "${pack.id}" template "${name}" missing template.title`,
        ).toBe(true);
        // Identity must not leak into the doc a new file receives.
        expect(
          starterContent.includes('template:'),
          `Pack "${pack.id}" template "${name}" leaks template: into starter content`,
        ).toBe(false);
      }
    }
  });
});
