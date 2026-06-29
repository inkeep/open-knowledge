
import { describe, expect, test } from 'bun:test';
import {
  parseTemplateFile,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import { STARTER_PACKS } from './starter.ts';

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
        expect(
          starterContent.includes('template:'),
          `Pack "${pack.id}" template "${name}" leaks template: into starter content`,
        ).toBe(false);
      }
    }
  });
});
