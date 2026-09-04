import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { afterEach, describe, expect, test } from 'vitest';
import { projectInPlaceSkill } from './skill-projection.ts';

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
      mode: 'link',
    });

    expect(form(cursor)).toBe('copy');
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
    const { cwd, canonical, canonicalHash } = setup();

    projectInPlaceSkill({
      canonicalAbs: canonical,
      canonicalHash,
      canonicalRootRel: '.claude/skills',
      name: 'demo',
      cwd,
      targets: ['claude'],
      mode: 'link',
      convertCopies: true,
    });

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
