import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';

const SKILLS_ROOT = join(import.meta.dirname, '../assets/skills');

function shippedSkillFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return shippedSkillFiles(path);
    return entry.name === 'SKILL.md' ? [path] : [];
  });
}

function frontmatterOf(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (match?.[1] === undefined) throw new Error('missing frontmatter block');
  return match[1];
}

const skillFiles = shippedSkillFiles(SKILLS_ROOT);

describe('shipped SKILL.md frontmatter under a strict YAML parser', () => {
  test('the walk finds the shipped skills', () => {
    expect(skillFiles.length).toBeGreaterThan(10);
  });

  test.each(skillFiles.map((path) => [relative(SKILLS_ROOT, path), path]))(
    '%s parses with js-yaml into a mapping of name, description and string fields',
    (_label, path) => {
      const parsed = load(frontmatterOf(readFileSync(path, 'utf8')));
      expect(parsed).toBeTypeOf('object');
      const fields = parsed as Record<string, unknown>;
      expect(fields.name).toBeTypeOf('string');
      expect(fields.description).toBeTypeOf('string');
      for (const key of ['description', 'compatibility'] as const) {
        if (fields[key] === undefined) continue;
        expect(fields[key]).toBeTypeOf('string');
        expect(fields[key] as string).not.toMatch(/["\\]$/);
      }
    },
  );
});
