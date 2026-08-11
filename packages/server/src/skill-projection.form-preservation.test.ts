import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { afterEach, describe, expect, test } from 'vitest';
import { projectInPlaceSkill } from './skill-projection.ts';

/**
 * Adding ONE editor must not restamp the form of locations the user already set
 * up. The two directions used to be asymmetric — an existing symlink survived an
 * implicit install, an existing copy did not — so installing a new host silently
 * converted every copy into a symlink (and, with the other default, every
 * symlink into a copy). Either way the placement ledger then disagreed with disk
 * and the UI reported the user's own install as "changed outside".
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-form-'));
  dirs.push(cwd);
  const canonical = join(cwd, '.claude/skills/demo');
  mkdirSync(canonical, { recursive: true });
  writeFileSync(join(canonical, 'SKILL.md'), '---\nname: demo\n---\nbody\n');
  const canonicalHash = parseSkillDir(canonical)?.contentHash ?? '';
  return { cwd, canonical, canonicalHash };
}

const form = (p: string) => (lstatSync(p).isSymbolicLink() ? 'link' : 'copy');

describe('projectInPlaceSkill form preservation', () => {
  test('an implicit link install leaves an existing COPY as a copy', () => {
    const { cwd, canonical, canonicalHash } = setup();
    // .cursor already holds an independent copy the user set up.
    const cursor = join(cwd, '.cursor/skills/demo');
    mkdirSync(cursor, { recursive: true });
    writeFileSync(join(cursor, 'SKILL.md'), '---\nname: demo\n---\nbody\n');

    projectInPlaceSkill({
      canonicalAbs: canonical,
      canonicalHash,
      canonicalRootRel: '.claude/skills',
      name: 'demo',
      cwd,
      targets: ['cursor', 'codex'],
      mode: 'link', // implicit preference, NOT an explicit user choice
    });

    expect(form(cursor)).toBe('copy');
    // The brand-new location still follows the preference.
    expect(form(join(cwd, '.codex/skills/demo'))).toBe('link');
  });

  test('an EXPLICIT link choice does convert an existing copy', () => {
    const { cwd, canonical, canonicalHash } = setup();
    const cursor = join(cwd, '.cursor/skills/demo');
    mkdirSync(cursor, { recursive: true });
    writeFileSync(join(cursor, 'SKILL.md'), '---\nname: demo\n---\nbody\n');

    projectInPlaceSkill({
      canonicalAbs: canonical,
      canonicalHash,
      canonicalRootRel: '.claude/skills',
      name: 'demo',
      cwd,
      targets: ['cursor'],
      mode: 'link',
      convertCopies: true,
    });

    expect(form(cursor)).toBe('link');
  });

  test("the CANONICAL host's own dir also follows an explicit link flip", () => {
    // Distinct branch: when the target editor's root IS the canonical root, the
    // loop never creates a copy — it takes the early arm and only converts an
    // EXISTING occurrence. Every other test here exercises the non-canonical
    // arm, so this one covers the leftover-same-hash-copy case that would
    // otherwise stay a copy while the menu claims the skill is linked.
    const { cwd, canonical, canonicalHash } = setup();

    projectInPlaceSkill({
      canonicalAbs: canonical,
      canonicalHash,
      // The canonical root and the target host's root are the SAME dir.
      canonicalRootRel: '.claude/skills',
      name: 'demo',
      cwd,
      targets: ['claude'],
      mode: 'link',
      convertCopies: true,
    });

    // The canonical is the source of truth and stays a real directory (`copy`
    // in this helper's vocabulary) — the flip must never turn it into a link to
    // itself, which is what makes this arm's early `continue` load-bearing.
    expect(form(canonical)).toBe('copy');
  });

  test('an implicit copy install leaves an existing SYMLINK as a symlink', () => {
    const { cwd, canonical, canonicalHash } = setup();
    const agentsRoot = join(cwd, '.agents/skills');
    mkdirSync(agentsRoot, { recursive: true });
    const agents = join(agentsRoot, 'demo');
    symlinkSync(canonical, agents, 'dir');

    projectInPlaceSkill({
      canonicalAbs: canonical,
      canonicalHash,
      canonicalRootRel: '.claude/skills',
      name: 'demo',
      cwd,
      targets: ['agents', 'codex'],
      mode: 'copy',
    });

    expect(form(agents)).toBe('link');
  });
});
