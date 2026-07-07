import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySkillBundleFileDelete,
  applySkillBundleFileWrite,
  applySkillDelete,
  applySkillMove,
  applySkillWrite,
} from './skills-write.ts';

let root: string;
let skillsRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-skills-'));
  skillsRoot = join(root, '.ok', 'skills');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fm = (name: string, description = 'Use when testing.') => ({ name, description });

describe('applySkillWrite', () => {
  test('creates SKILL.md with composed name+description frontmatter', () => {
    const result = applySkillWrite({
      skillsRoot,
      name: 'trip-log',
      body: '# Steps\n\nDo the thing.',
      frontmatter: fm('trip-log', 'Use when logging a fishing trip.'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.path).toBe('trip-log/SKILL.md');
    const raw = readFileSync(join(skillsRoot, 'trip-log', 'SKILL.md'), 'utf-8');
    expect(raw).toContain('name: trip-log');
    expect(raw).toContain('description: Use when logging a fishing trip.');
    expect(raw).toContain('# Steps');
    // No injected keys — frontmatter purity: only name + description.
    expect(raw).not.toContain('version:');
    expect(raw).not.toContain('title:');
  });

  test('second write reports created:false (overwrite)', () => {
    applySkillWrite({ skillsRoot, name: 's', body: 'a', frontmatter: fm('s') });
    const again = applySkillWrite({ skillsRoot, name: 's', body: 'b', frontmatter: fm('s') });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.created).toBe(false);
  });

  test('rejects name != directory', () => {
    const result = applySkillWrite({
      skillsRoot,
      name: 'trip-log',
      body: 'x',
      frontmatter: fm('different'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NAME_DIR_MISMATCH');
  });

  test('rejects XML tag in description', () => {
    const result = applySkillWrite({
      skillsRoot,
      name: 'x',
      body: 'b',
      frontmatter: fm('x', 'Use when <folder> appears.'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('XML_TAG_IN_DESCRIPTION');
  });

  test('rejects an uppercase / dotted / spaced name', () => {
    for (const bad of ['TripLog', 'trip.log', 'trip log', 'trip/log']) {
      const result = applySkillWrite({ skillsRoot, name: bad, body: 'b', frontmatter: fm(bad) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('BAD_NAME');
    }
  });

  test('rejects reserved words in name', () => {
    const result = applySkillWrite({
      skillsRoot,
      name: 'claude-helper',
      body: 'b',
      frontmatter: fm('claude-helper'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RESERVED_NAME');
  });

  test('rejects empty description and over-long description', () => {
    const empty = applySkillWrite({ skillsRoot, name: 'a', body: 'b', frontmatter: fm('a', '') });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('SKILL_DESCRIPTION_REQUIRED');

    const long = applySkillWrite({
      skillsRoot,
      name: 'a',
      body: 'b',
      frontmatter: fm('a', 'x'.repeat(1025)),
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.code).toBe('DESCRIPTION_TOO_LONG');
  });

  test('warns (not errors) on a >500-line body', () => {
    const result = applySkillWrite({
      skillsRoot,
      name: 'big',
      body: Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n'),
      frontmatter: fm('big'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.some((w) => w.includes('600 lines'))).toBe(true);
  });
});

describe('applySkillDelete', () => {
  test('removes the whole skill dir and reports existed', () => {
    applySkillWrite({ skillsRoot, name: 's', body: 'a', frontmatter: fm('s') });
    expect(existsSync(join(skillsRoot, 's'))).toBe(true);
    const result = applySkillDelete({ skillsRoot, name: 's' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.existed).toBe(true);
    expect(existsSync(join(skillsRoot, 's'))).toBe(false);
  });

  test('no-op delete of an absent skill reports existed:false', () => {
    const result = applySkillDelete({ skillsRoot, name: 'ghost' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.existed).toBe(false);
  });

  test('cleans an emptied .ok/skills then .ok', () => {
    applySkillWrite({ skillsRoot, name: 'only', body: 'a', frontmatter: fm('only') });
    applySkillDelete({ skillsRoot, name: 'only' });
    expect(existsSync(skillsRoot)).toBe(false);
    expect(existsSync(join(root, '.ok'))).toBe(false);
  });
});

describe('applySkillMove', () => {
  const fsRelocate = async (from: string, to: string) => {
    const { renameSync } = await import('node:fs');
    renameSync(from, to);
    return false; // plain rename (untracked)
  };

  test('renames the skill dir', async () => {
    applySkillWrite({ skillsRoot, name: 'old', body: 'a', frontmatter: fm('old') });
    const result = await applySkillMove({
      skillsRoot,
      fromName: 'old',
      toName: 'new',
      relocate: fsRelocate,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(skillsRoot, 'old'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'new', 'SKILL.md'))).toBe(true);
  });

  test('refuses a collision with an existing destination', async () => {
    applySkillWrite({ skillsRoot, name: 'a', body: 'x', frontmatter: fm('a') });
    applySkillWrite({ skillsRoot, name: 'b', body: 'y', frontmatter: fm('b') });
    const result = await applySkillMove({
      skillsRoot,
      fromName: 'a',
      toName: 'b',
      relocate: fsRelocate,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SKILL_EXISTS');
  });

  test('refuses a missing source and a no-op self-move', async () => {
    const missing = await applySkillMove({
      skillsRoot,
      fromName: 'ghost',
      toName: 'x',
      relocate: fsRelocate,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('SKILL_NOT_FOUND');

    applySkillWrite({ skillsRoot, name: 'same', body: 'x', frontmatter: fm('same') });
    const noop = await applySkillMove({
      skillsRoot,
      fromName: 'same',
      toName: 'same',
      relocate: fsRelocate,
    });
    expect(noop.ok).toBe(false);
    if (!noop.ok) expect(noop.error.code).toBe('NOOP');
  });
});

describe('applySkillBundleFileWrite / applySkillBundleFileDelete (fs-direct)', () => {
  const seedSkill = (name = 'trip-log') =>
    applySkillWrite({ skillsRoot, name, body: '# Steps', frontmatter: fm(name) });

  test('writes a reference + a script into an existing skill (atomic, created flag)', () => {
    seedSkill();
    const ref = applySkillBundleFileWrite({
      skillsRoot,
      name: 'trip-log',
      relPath: 'references/gear.md',
      content: '# Gear\n\nRods.',
    });
    expect(ref.ok).toBe(true);
    if (ref.ok) {
      expect(ref.created).toBe(true);
      expect(ref.path).toBe('trip-log/references/gear.md');
    }
    expect(readFileSync(join(skillsRoot, 'trip-log', 'references', 'gear.md'), 'utf-8')).toContain(
      '# Gear',
    );

    const script = applySkillBundleFileWrite({
      skillsRoot,
      name: 'trip-log',
      relPath: 'scripts/run.sh',
      content: '#!/usr/bin/env bash\necho hi\n',
    });
    expect(script.ok).toBe(true);
    if (script.ok) expect(script.created).toBe(true);

    // Overwrite reports created:false.
    const again = applySkillBundleFileWrite({
      skillsRoot,
      name: 'trip-log',
      relPath: 'references/gear.md',
      content: '# Gear v2',
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.created).toBe(false);
  });

  test('refuses a write into a skill that does not exist', () => {
    const r = applySkillBundleFileWrite({
      skillsRoot,
      name: 'ghost',
      relPath: 'references/x.md',
      content: 'x',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SKILL_NOT_FOUND');
  });

  test('rejects an escaping path and an over-cap file', () => {
    seedSkill();
    const escaping = applySkillBundleFileWrite({
      skillsRoot,
      name: 'trip-log',
      relPath: 'references/../../escape.md',
      content: 'x',
    });
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) expect(escaping.error.code).toBe('BAD_FILE_PATH');

    const tooLarge = applySkillBundleFileWrite({
      skillsRoot,
      name: 'trip-log',
      relPath: 'references/big.md',
      content: 'a'.repeat(256 * 1024 + 1),
    });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.error.code).toBe('FILE_TOO_LARGE');
  });

  test('enforces the per-skill file-count cap', () => {
    seedSkill();
    for (let i = 0; i < 50; i++) {
      const r = applySkillBundleFileWrite({
        skillsRoot,
        name: 'trip-log',
        relPath: `references/r${i}.md`,
        content: `# ${i}`,
      });
      expect(r.ok).toBe(true);
    }
    const overflow = applySkillBundleFileWrite({
      skillsRoot,
      name: 'trip-log',
      relPath: 'references/one-too-many.md',
      content: 'x',
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe('TOO_MANY_FILES');
  });

  test('deletes a bundle file and prunes the emptied dir; no-op reports existed:false', () => {
    seedSkill();
    applySkillBundleFileWrite({
      skillsRoot,
      name: 'trip-log',
      relPath: 'references/gear.md',
      content: 'x',
    });
    const del = applySkillBundleFileDelete({
      skillsRoot,
      name: 'trip-log',
      relPath: 'references/gear.md',
    });
    expect(del.ok).toBe(true);
    if (del.ok) expect(del.existed).toBe(true);
    // Emptied references/ pruned; SKILL.md + skill dir intact.
    expect(existsSync(join(skillsRoot, 'trip-log', 'references'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'trip-log', 'SKILL.md'))).toBe(true);

    const noop = applySkillBundleFileDelete({
      skillsRoot,
      name: 'trip-log',
      relPath: 'references/gear.md',
    });
    expect(noop.ok).toBe(true);
    if (noop.ok) expect(noop.existed).toBe(false);
  });
});
