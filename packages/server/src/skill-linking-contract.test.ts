import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the link-authoring contract in the bundled project skill so a later
 * edit can't silently regress it. The skill is a lean core (`SKILL.md`) plus
 * on-demand `references/`; the linking contract's detail lives in
 * `references/linking.md`, with the core carrying the MUST + a pointer.
 *
 * - Core and linking reference stay SELF-CONTAINED — no `precedent #N` cite /
 *   `PRECEDENTS.md` link (dead references for end users who never see the
 *   in-repo precedent ledger).
 * - The linking reference states relative-default + the no-hybrid rule and
 *   makes the inline `brokenLinks` signal the primary write-time check, with
 *   `links({ kind: "dead" })` as the end-state audit.
 * - The core points at `brokenLinks` and the linking reference.
 * - The docs core-concepts page states relative-default + the no-hybrid rule.
 */

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

  test('linking reference makes brokenLinks the primary check + keeps the dead-link sweep as end-state audit', () => {
    expect(linking).toMatch(/`brokenLinks`[^\n]*primary check/);
    expect(linking).toContain('authoritative end-state audit');
  });
});

describe('docs core-concepts.md — link form guidance', () => {
  const doc = readFileSync(CORE_CONCEPTS_PATH, 'utf-8');

  test('states relative is recommended + the no-hybrid rule', () => {
    expect(doc).toContain('The recommended form is **relative**');
    expect(doc).toContain('never glue `./` onto a content-root path');
  });
});
