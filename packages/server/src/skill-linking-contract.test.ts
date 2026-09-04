import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SKILL_PATH = join(import.meta.dir, '../assets/skills/project/SKILL.md');
const LINKING_PATH = join(import.meta.dir, '../assets/skills/project/references/linking.md');
const CORE_CONCEPTS_PATH = join(
  import.meta.dir,
  '../../../docs/content/reference/core-concepts.md',
);

describe('bundled project skill — link-authoring contract', () => {
  const skill = readFileSync(SKILL_PATH, 'utf-8');
  const linking = readFileSync(LINKING_PATH, 'utf-8');

  test('core + linking reference stay self-contained: no precedent citation, no PRECEDENTS.md link', () => {
    for (const text of [skill, linking]) {
      expect(text).not.toMatch(/precedent #/i);
      expect(text).not.toContain('PRECEDENTS.md');
    }
  });

  test('core points at brokenLinks and the linking reference', () => {
    expect(skill).toContain('brokenLinks');
    expect(skill).toContain('references/linking.md');
  });

  test('linking reference states relative is the recommended default + the no-hybrid rule', () => {
    expect(linking).toContain('the recommended default');
    expect(linking).toContain('Never glue `./` onto a content-root path');
  });

  test('linking reference makes brokenLinks the primary check + names `audit` as the end-state check', () => {
    expect(linking).toMatch(/`brokenLinks`[^\n]*primary check/);
    expect(linking).toContain('`audit` is the authoritative end-state link check');
    expect(linking).not.toContain('authoritative end-state audit');
  });
});

describe('docs core-concepts.md — link form guidance', () => {
  const doc = readFileSync(CORE_CONCEPTS_PATH, 'utf-8');

  test('states relative is recommended + the no-hybrid rule', () => {
    expect(doc).toContain('The recommended form is **relative**');
    expect(doc).toContain('never glue `./` onto a content-root path');
  });
});
