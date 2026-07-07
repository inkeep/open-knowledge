import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { readInstalledSkills } from './installed-skills-marker.ts';
import { countImportableEditorSkills, reconcileSkillInstalls } from './skill-reconcile.ts';

let root: string;
let skillsRoot: string;

/** Author a managed source skill under `.ok/skills/<name>`. */
function makeSource(name: string, body = '# Steps'): string {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Use when testing.\n---\n${body}`,
  );
  return dir;
}

/** Plant a real-dir skill copy under an editor host root (a foreign/legacy copy). */
function makeEditorCopy(editorRel: string, name: string, body = '# Steps'): string {
  const dir = join(root, editorRel, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Use when testing.\n---\n${body}`,
  );
  return dir;
}

function isLinkToSource(editorRel: string, name: string, sourceName = name): boolean {
  const link = join(root, editorRel, name);
  if (!lstatSync(link).isSymbolicLink()) return false;
  return existsSync(join(link, 'SKILL.md')) && existsSync(join(skillsRoot, sourceName, 'SKILL.md'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-reconcile-'));
  skillsRoot = join(root, '.ok', 'skills');
  mkdirSync(skillsRoot, { recursive: true });
  // Adoption of non-`.ok` editor skills is gated on the project being OK-managed
  // (default off). Most tests here exercise adopt/collision, so default the suite
  // to managed via the env override; the OFF-specific tests clear it.
  process.env.OK_SKILL_MANAGE = '1';
});
afterEach(() => {
  delete process.env.OK_SKILL_MANAGE;
  rmSync(root, { recursive: true, force: true });
});

describe('reconcileSkillInstalls', () => {
  test('leaves a correct managed symlink untouched', async () => {
    const src = makeSource('trip-log');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    const link = join(root, '.claude', 'skills', 'trip-log');
    symlinkSync(relative(join(root, '.claude', 'skills'), src), link, 'dir');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.healed).toEqual([]);
    expect(r.adopted).toEqual([]);
    expect(isLinkToSource('.claude/skills', 'trip-log')).toBe(true);
  });

  test('heals a broken / wrong-target link to point at the source', async () => {
    makeSource('trip-log');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    const link = join(root, '.claude', 'skills', 'trip-log');
    symlinkSync('/nonexistent/elsewhere', link, 'dir'); // drifted link

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.healed).toContainEqual({ name: 'trip-log', editor: 'claude' });
    expect(isLinkToSource('.claude/skills', 'trip-log')).toBe(true);
  });

  test('removes an orphan link whose source is gone', async () => {
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    const link = join(root, '.claude', 'skills', 'ghost');
    symlinkSync('/nonexistent/elsewhere', link, 'dir');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.orphansRemoved).toContainEqual({ name: 'ghost', editor: 'claude' });
    expect(existsSync(link)).toBe(false);
  });

  test('adopts a foreign real-dir skill into .ok/skills and symlinks it + marks installed', async () => {
    makeEditorCopy('.codex/skills', 'recipe', '# Foreign body');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.adopted).toContainEqual({ name: 'recipe', editor: 'codex' });
    // Source now lives under .ok/skills with the foreign content preserved.
    expect(readFileSync(join(skillsRoot, 'recipe', 'SKILL.md'), 'utf-8')).toContain(
      '# Foreign body',
    );
    // The editor entry is now a symlink, not a real dir.
    expect(isLinkToSource('.codex/skills', 'recipe')).toBe(true);
    // Marker badges it installed on codex.
    expect(readInstalledSkills(root).skills.recipe?.hosts).toEqual(['codex']);
  });

  test('replaces a redundant real-dir copy (same content as source) with a symlink', async () => {
    makeSource('dup', '# Same');
    makeEditorCopy('.claude/skills', 'dup', '# Same'); // identical content

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.replaced).toContainEqual({ name: 'dup', editor: 'claude' });
    expect(isLinkToSource('.claude/skills', 'dup')).toBe(true);
  });

  // The cross-harness skill sync reformats / extends frontmatter across runs, so
  // a host copy of an ALREADY-managed skill is rarely byte-identical to its
  // `.ok/skills` source. These cases must read as "same skill" (redundant →
  // symlink), NOT a collision — otherwise every managed skill re-collides on each
  // boot and spawns `<name>-<editor>` duplicates (the bug these guard).
  test('frontmatter serialization-only diff → redundant (symlink), not a collision', async () => {
    mkdirSync(join(skillsRoot, 'route-plan'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'route-plan', 'SKILL.md'),
      '---\nname: route-plan\ndescription: "A long value here."\n---\n# Body\n',
    );
    mkdirSync(join(root, '.codex', 'skills', 'route-plan'), { recursive: true });
    // Same `description` value, folded across lines — different YAML serialization.
    writeFileSync(
      join(root, '.codex', 'skills', 'route-plan', 'SKILL.md'),
      '---\nname: route-plan\ndescription: >-\n  A long value\n  here.\n---\n# Body\n',
    );

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.collided).toEqual([]);
    expect(r.replaced).toContainEqual({ name: 'route-plan', editor: 'codex' });
    expect(isLinkToSource('.codex/skills', 'route-plan')).toBe(true);
    expect(existsSync(join(skillsRoot, 'route-plan-codex'))).toBe(false);
  });

  test('additive frontmatter field (argument-hint) → redundant, not a collision', async () => {
    mkdirSync(join(skillsRoot, 'dx'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'dx', 'SKILL.md'),
      '---\nname: dx\ndescription: Use it.\n---\n# Body\n', // source lacks argument-hint
    );
    mkdirSync(join(root, '.cursor', 'skills', 'dx'), { recursive: true });
    writeFileSync(
      join(root, '.cursor', 'skills', 'dx', 'SKILL.md'),
      '---\nname: dx\ndescription: Use it.\nargument-hint: "[add|list]"\n---\n# Body\n', // host adds it
    );

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.collided).toEqual([]);
    expect(r.replaced).toContainEqual({ name: 'dx', editor: 'cursor' });
    expect(existsSync(join(skillsRoot, 'dx-cursor'))).toBe(false);
  });

  test('conflicting shared frontmatter value → genuine collision (suffix-adopted)', async () => {
    mkdirSync(join(skillsRoot, 'tool'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'tool', 'SKILL.md'),
      '---\nname: tool\ndescription: First meaning.\n---\n# Body\n',
    );
    mkdirSync(join(root, '.cursor', 'skills', 'tool'), { recursive: true });
    // Same key, genuinely different value → a real variant, must be preserved.
    writeFileSync(
      join(root, '.cursor', 'skills', 'tool', 'SKILL.md'),
      '---\nname: tool\ndescription: A different meaning entirely.\n---\n# Body\n',
    );

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.collided).toContainEqual({ name: 'tool', editor: 'cursor' });
    expect(existsSync(join(skillsRoot, 'tool-cursor', 'SKILL.md'))).toBe(true);
  });

  test('differing sibling file (scripts/) → genuine collision even when SKILL.md matches', async () => {
    mkdirSync(join(skillsRoot, 'gizmo', 'scripts'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'gizmo', 'SKILL.md'),
      '---\nname: gizmo\ndescription: g.\n---\n# Body\n',
    );
    writeFileSync(join(skillsRoot, 'gizmo', 'scripts', 'run.sh'), 'echo source\n');
    mkdirSync(join(root, '.cursor', 'skills', 'gizmo', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, '.cursor', 'skills', 'gizmo', 'SKILL.md'),
      '---\nname: gizmo\ndescription: g.\n---\n# Body\n', // identical manifest
    );
    writeFileSync(
      join(root, '.cursor', 'skills', 'gizmo', 'scripts', 'run.sh'),
      'echo HOST DIFFERENT\n', // sibling code genuinely differs
    );

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.collided).toContainEqual({ name: 'gizmo', editor: 'cursor' });
  });

  // Project-managed gate (default off): adoption of non-`.ok` editor skills only
  // runs when the project is OK-managed. These set OK_SKILL_MANAGE=0 to assert the
  // default-off behavior — the failure this whole feature exists to prevent.
  test('management OFF: a foreign real-dir editor skill is left untouched (skipped, not adopted)', async () => {
    process.env.OK_SKILL_MANAGE = '0';
    const foreign = join(root, '.codex', 'skills', 'recipe');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'SKILL.md'), '---\nname: recipe\ndescription: x.\n---\n# Foreign');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.adopted).toEqual([]);
    expect(r.collided).toEqual([]);
    expect(r.skipped).toContainEqual({ name: 'recipe', editor: 'codex' });
    // Source NOT created; the editor entry is still a real dir, byte-unchanged.
    expect(existsSync(join(skillsRoot, 'recipe'))).toBe(false);
    expect(lstatSync(foreign).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(foreign, 'SKILL.md'), 'utf-8')).toContain('# Foreign');
  });

  test('countImportableEditorSkills counts foreign editor skills, deduped across roots, ignoring managed copies', () => {
    // Foreign skill mirrored into two editor roots → counts once.
    makeEditorCopy('.codex/skills', 'recipe', '# A');
    makeEditorCopy('.agents/skills', 'recipe', '# A');
    // A second, distinct foreign skill → +1.
    makeEditorCopy('.cursor/skills', 'planner', '# B');
    // A real-dir copy of an EXISTING .ok skill → NOT importable (already managed).
    makeSource('trip-log', '# Same');
    makeEditorCopy('.claude/skills', 'trip-log', '# Same');

    expect(countImportableEditorSkills({ projectDir: root, skillsRoot })).toBe(2);
  });

  test('countImportableEditorSkills is 0 when there are no foreign editor skills', () => {
    makeSource('only-ok', '# x');
    expect(countImportableEditorSkills({ projectDir: root, skillsRoot })).toBe(0);
  });

  test('management OFF: an EXISTING .ok skill still heals + redundant-collapses (always-on)', async () => {
    process.env.OK_SKILL_MANAGE = '0';
    makeSource('trip-log', '# Same');
    // drifted link → still healed
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    symlinkSync('/nonexistent', join(root, '.claude', 'skills', 'trip-log'), 'dir');
    // redundant real-dir copy of the .ok skill → still collapsed to a symlink
    makeEditorCopy('.cursor/skills', 'trip-log', '# Same');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.healed).toContainEqual({ name: 'trip-log', editor: 'claude' });
    expect(r.replaced).toContainEqual({ name: 'trip-log', editor: 'cursor' });
    expect(isLinkToSource('.claude/skills', 'trip-log')).toBe(true);
    expect(isLinkToSource('.cursor/skills', 'trip-log')).toBe(true);
  });

  test('suffix-adopts a colliding real-dir copy (different content) without deleting it', async () => {
    makeSource('clash', '# OK managed version');
    makeEditorCopy('.cursor/skills', 'clash', '# A genuinely different skill');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.collided).toContainEqual({ name: 'clash', editor: 'cursor' });
    // The OK-managed source is untouched.
    expect(readFileSync(join(skillsRoot, 'clash', 'SKILL.md'), 'utf-8')).toContain(
      '# OK managed version',
    );
    // The foreign copy is preserved under a suffixed source, never deleted.
    expect(readFileSync(join(skillsRoot, 'clash-cursor', 'SKILL.md'), 'utf-8')).toContain(
      '# A genuinely different skill',
    );
    expect(isLinkToSource('.cursor/skills', 'clash-cursor', 'clash-cursor')).toBe(true);
    // No real-dir copy lingers at the original editor path.
    expect(existsSync(join(root, '.cursor', 'skills', 'clash'))).toBe(false);
    // The marker records the suffixed skill as installed on its editor host, so
    // the Skills list badges it Installed (not Draft). A silently-dropped marker
    // update (e.g. validateSkillForInstall failing on the suffixed frontmatter)
    // would leave it showing Draft despite being on disk + linked.
    expect(readInstalledSkills(root).skills['clash-cursor']?.hosts).toEqual(['cursor']);
  });

  test('leaves the foreign copy untouched when the suffixed collision slot is already occupied', async () => {
    // Double collision: an OK-managed `clash`, a genuinely different foreign
    // copy under the same name, AND the suffixed slot `clash-cursor` already
    // holds yet another skill. The no-delete invariant must win — skip rather
    // than overwrite the occupied suffixed slot. (Regression pin for the guard
    // at skill-reconcile.ts; without it a refactor could destroy user content.)
    makeSource('clash', '# OK managed version');
    makeEditorCopy('.cursor/skills', 'clash', '# A genuinely different skill');
    makeSource('clash-cursor', '# Already present in the suffixed slot');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });

    // The collision was skipped, not adopted into the occupied slot.
    expect(r.collided).toEqual([]);
    // The foreign real-dir copy is left in place (not moved, not deleted).
    expect(lstatSync(join(root, '.cursor', 'skills', 'clash')).isDirectory()).toBe(true);
    expect(readFileSync(join(root, '.cursor', 'skills', 'clash', 'SKILL.md'), 'utf-8')).toContain(
      '# A genuinely different skill',
    );
    // The pre-occupied suffixed source is byte-for-byte untouched.
    expect(readFileSync(join(skillsRoot, 'clash-cursor', 'SKILL.md'), 'utf-8')).toContain(
      '# Already present in the suffixed slot',
    );
  });

  test('skips a host-dir entry whose name is not a valid skill id (never adopted)', async () => {
    // `Invalid_Name` fails SKILL_NAME_REGEX (uppercase + underscore). It must not
    // be adopted into `.ok/skills/` — the name would become an invalid skill
    // identity. A valid sibling in the same host dir still reconciles normally.
    makeEditorCopy('.codex/skills', 'Invalid_Name', '# Not a skill');
    makeEditorCopy('.codex/skills', 'valid-skill', '# Real foreign skill');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });

    // The invalid entry was skipped on every axis.
    expect(r.adopted).not.toContainEqual({ name: 'Invalid_Name', editor: 'codex' });
    expect(existsSync(join(skillsRoot, 'Invalid_Name'))).toBe(false);
    // Left in place (not deleted) so the user can fix it manually.
    expect(lstatSync(join(root, '.codex', 'skills', 'Invalid_Name')).isDirectory()).toBe(true);
    // The valid sibling still adopts.
    expect(r.adopted).toContainEqual({ name: 'valid-skill', editor: 'codex' });
    expect(isLinkToSource('.codex/skills', 'valid-skill')).toBe(true);
  });

  test('adopts from the generic .agents broadcast dir (no per-editor marker host)', async () => {
    makeEditorCopy('.agents/skills', 'shared', '# Broadcast');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.adopted).toContainEqual({ name: 'shared', editor: null });
    expect(existsSync(join(skillsRoot, 'shared', 'SKILL.md'))).toBe(true);
    expect(isLinkToSource('.agents/skills', 'shared')).toBe(true);
    // `.agents` is not a per-editor install dir → no marker host recorded.
    expect(readInstalledSkills(root).skills.shared).toBeUndefined();
  });

  test('leaves the shipped open-knowledge bundle copy untouched', async () => {
    const bundle = makeEditorCopy('.claude/skills', 'open-knowledge', '# Shipped');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    const all = [...r.adopted, ...r.replaced, ...r.collided, ...r.healed];
    expect(all.find((a) => a.name === 'open-knowledge')).toBeUndefined();
    // Still a real dir (copy), not a symlink.
    expect(lstatSync(bundle).isSymbolicLink()).toBe(false);
  });
});
