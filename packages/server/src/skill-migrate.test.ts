import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readInstalledSkills, recordSkillInstall } from './installed-skills-marker.ts';
import { genuineInPlaceNames, migrateStoreSkillsInPlace } from './skill-migrate.ts';
import { recordSkillPlacement } from './skill-placements.ts';

let root: string;
let skillsRoot: string;

function makeStore(name: string, body = '# Steps'): string {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Use when testing.\n---\n${body}`,
  );
  return dir;
}

/** OK-style relative symlink projection at `<editorRel>/<name>` → the store dir. */
function linkProjection(editorRel: string, name: string): string {
  const hostRoot = join(root, editorRel);
  mkdirSync(hostRoot, { recursive: true });
  const link = join(hostRoot, name);
  symlinkSync(relative(hostRoot, join(skillsRoot, name)), link, 'dir');
  return link;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-migrate-'));
  skillsRoot = join(root, '.ok', 'skills');
  mkdirSync(skillsRoot, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('migrateStoreSkillsInPlace', () => {
  test('moves a projected skill to its top-precedence host; other links become copies', async () => {
    makeStore('foo', '# Body');
    linkProjection('.claude/skills', 'foo');
    linkProjection('.codex/skills', 'foo');
    await recordSkillInstall(root, 'foo', {
      hosts: ['claude', 'codex'],
      scope: 'project',
      scripts: false,
      installedAt: new Date().toISOString(),
    });

    const r = await migrateStoreSkillsInPlace({ projectDir: root, skillsRoot });
    expect(r.migrated).toContainEqual({ name: 'foo', to: '.claude/skills/foo' });
    // Canonical is now a REAL dir at the claude host; store dir gone.
    const canonical = join(root, '.claude/skills/foo');
    expect(lstatSync(canonical).isDirectory()).toBe(true);
    expect(lstatSync(canonical).isSymbolicLink()).toBe(false);
    expect(existsSync(join(skillsRoot, 'foo'))).toBe(false);
    // The codex projection became a real copy (still loads there).
    const codex = join(root, '.codex/skills/foo');
    expect(lstatSync(codex).isDirectory()).toBe(true);
    expect(lstatSync(codex).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(codex, 'SKILL.md'), 'utf-8')).toContain('# Body');
    // Marker entry dropped — the in-place scan is truth now.
    expect(readInstalledSkills(root).skills.foo).toBeUndefined();
  });

  test('an unprojected (draft) skill lands in a concrete editor dir, never inventing .agents', async () => {
    makeStore('draft', '# D');
    const r = await migrateStoreSkillsInPlace({ projectDir: root, skillsRoot });
    // No editor roots exist and no `.agents` adoption — the fallback is the
    // top-precedence concrete harness dir, NOT an OK-invented hub.
    expect(r.migrated).toContainEqual({ name: 'draft', to: '.claude/skills/draft' });
    expect(existsSync(join(root, '.claude/skills/draft/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.agents'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'draft'))).toBe(false);
  });

  test('a same-hash real copy at a host becomes the canonical; store dir removed', async () => {
    const store = makeStore('dup', '# Same');
    const hostDir = join(root, '.claude/skills/dup');
    mkdirSync(join(root, '.claude/skills'), { recursive: true });
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(join(hostDir, 'SKILL.md'), readFileSync(join(store, 'SKILL.md')));

    const r = await migrateStoreSkillsInPlace({ projectDir: root, skillsRoot });
    expect(r.migrated).toContainEqual({ name: 'dup', to: '.claude/skills/dup' });
    expect(existsSync(join(skillsRoot, 'dup'))).toBe(false);
    expect(readFileSync(join(hostDir, 'SKILL.md'), 'utf-8')).toContain('# Same');
  });

  test('NEVER clobbers: a differing real dir at the only target skips the skill', async () => {
    makeStore('clash', '# Store version');
    // The hub slot is occupied by a genuinely different skill; no projections.
    const hub = join(root, '.agents/skills/clash');
    mkdirSync(hub, { recursive: true });
    writeFileSync(join(hub, 'SKILL.md'), '---\nname: clash\ndescription: other.\n---\n# DIFFERENT');

    const r = await migrateStoreSkillsInPlace({ projectDir: root, skillsRoot });
    // The occupied hub slot is never clobbered; the store version lands at a
    // FREE concrete root instead (the fork then surfaces as a conflict).
    expect(r.migrated).toContainEqual({ name: 'clash', to: '.claude/skills/clash' });
    expect(readFileSync(join(root, '.claude/skills/clash/SKILL.md'), 'utf-8')).toContain(
      '# Store version',
    );
    expect(readFileSync(join(hub, 'SKILL.md'), 'utf-8')).toContain('# DIFFERENT');
  });

  test('a foreign symlink at a host is never touched (D7)', async () => {
    makeStore('linked', '# L');
    // Foreign symlink in .claude pointing somewhere else entirely.
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'SKILL.md'), '---\nname: linked\ndescription: x.\n---\n# E');
    mkdirSync(join(root, '.claude/skills'), { recursive: true });
    symlinkSync(elsewhere, join(root, '.claude/skills/linked'), 'dir');

    const r = await migrateStoreSkillsInPlace({ projectDir: root, skillsRoot });
    // Foreign link isn't a usable target and no other root exists — the skill
    // is SKIPPED (never clobbered, never inventing .agents), link untouched.
    expect(r.migrated).toEqual([]);
    expect(r.skipped).toContainEqual({
      name: 'linked',
      reason: 'target-occupied:.claude/skills (foreign-link)',
    });
    expect(lstatSync(join(root, '.claude/skills/linked')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(elsewhere, 'SKILL.md'), 'utf-8')).toContain('# E');
    expect(existsSync(join(skillsRoot, 'linked', 'SKILL.md'))).toBe(true);
  });

  test('GLOBAL roots: a user-home store skill migrates against user editor dirs', async () => {
    const { USER_HOST_ROOTS_BY_PRECEDENCE } = await import('./skill-migrate.ts');
    const store = makeStore('worldly', '# G');
    // Same-hash copy at pi's USER root (`.pi/agent/skills`, ≠ project `.pi/skills`).
    const piDir = join(root, '.pi/agent/skills/worldly');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'SKILL.md'), readFileSync(join(store, 'SKILL.md')));

    const r = await migrateStoreSkillsInPlace({
      projectDir: root,
      skillsRoot,
      hostRoots: USER_HOST_ROOTS_BY_PRECEDENCE,
    });
    expect(r.migrated).toContainEqual({ name: 'worldly', to: '.pi/agent/skills/worldly' });
    expect(existsSync(join(skillsRoot, 'worldly'))).toBe(false);
    expect(readFileSync(join(piDir, 'SKILL.md'), 'utf-8')).toContain('# G');
  });

  test('a placement of an in-place skill (inPlaceNames) is never migrated', async () => {
    makeStore('placed', '# P');
    const r = await migrateStoreSkillsInPlace({
      projectDir: root,
      skillsRoot,
      inPlaceNames: new Set(['placed']),
    });
    expect(r.migrated).toEqual([]);
    expect(existsSync(join(skillsRoot, 'placed', 'SKILL.md'))).toBe(true);
  });

  test('idempotent — an empty store is a no-op', async () => {
    const r = await migrateStoreSkillsInPlace({ projectDir: root, skillsRoot });
    expect(r.migrated).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});

describe('genuineInPlaceNames', () => {
  test('a symlink projection INTO the store is excluded (so the drain migrates it)', () => {
    makeStore('proj');
    linkProjection('.claude/skills', 'proj'); // .claude/skills/proj → ../../.ok/skills/proj
    // The scan would report `proj` as in-place (its canonical is the symlink),
    // but that canonical resolves into the store — it's a projection, not a
    // placement. Excluding it lets the drain relocate the store dir.
    const names = genuineInPlaceNames(root, [{ name: 'proj', dir: '.claude/skills/proj' }]);
    expect(names.has('proj')).toBe(false);
  });

  test('a GENUINE real in-place dir is included (drain must never clobber it)', () => {
    const realDir = join(root, '.agents/skills/real-one');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'SKILL.md'), '---\nname: real-one\ndescription: d\n---\n# R');
    const names = genuineInPlaceNames(root, [{ name: 'real-one', dir: '.agents/skills/real-one' }]);
    expect(names.has('real-one')).toBe(true);
  });
});

describe('migrateStoreSkillsInPlace — a deliberate placement is not residue', () => {
  test('a skill RECORDED at `.ok/skills` stays put; unrecorded residue still drains', async () => {
    // `.ok/skills` is an ordinary custom root: you can place a skill there, and
    // no other custom root has its contents relocated out from under it. The
    // ledger is what separates "the user chose this folder" from "left over
    // from the retired store" — residue has no ledger entry.
    makeStore('chosen', '# Chosen');
    makeStore('residue', '# Residue');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    await recordSkillPlacement(root, 'chosen', { path: '.ok/skills/chosen', mode: 'copy' });

    const r = await migrateStoreSkillsInPlace({ projectDir: root, skillsRoot });

    expect(existsSync(join(skillsRoot, 'chosen', 'SKILL.md'))).toBe(true);
    expect(r.skipped).toContainEqual({ name: 'chosen', reason: 'recorded-placement' });

    expect(existsSync(join(skillsRoot, 'residue'))).toBe(false);
    expect(r.migrated.map((m) => m.name)).toEqual(['residue']);
  });
});
