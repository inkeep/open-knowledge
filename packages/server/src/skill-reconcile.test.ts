import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { reconcileSkillInstalls } from './skill-reconcile.ts';

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

/** Plant a real-dir skill under an editor host root (an in-place skill). */
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
});
afterEach(() => {
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
    expect(r.replaced).toEqual([]);
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

  test('leaves a real-dir editor skill with no source untouched (in-place)', async () => {
    const foreign = join(root, '.codex', 'skills', 'recipe');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'SKILL.md'), '---\nname: recipe\ndescription: x.\n---\n# Foreign');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.skipped).toContainEqual({ name: 'recipe', editor: 'codex' });
    // NEVER moved into .ok/skills; the editor entry is still a real dir, byte-unchanged.
    expect(existsSync(join(skillsRoot, 'recipe'))).toBe(false);
    expect(lstatSync(foreign).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(foreign, 'SKILL.md'), 'utf-8')).toContain('# Foreign');
  });

  test('leaves a symlink resolving outside .ok/skills untouched, even unmanaged', async () => {
    const shared = join(root, 'shared-skills', 'toolbox');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'SKILL.md'), '---\nname: toolbox\n---\n# External');
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
    const link = join(root, '.agents', 'skills', 'toolbox');
    symlinkSync(relative(join(root, '.agents', 'skills'), shared), link, 'dir');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.orphansRemoved).toEqual([]);
    expect(r.healed).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, 'SKILL.md'), 'utf-8')).toContain('# External');
  });

  test('does not re-point a foreign resolving symlink at a same-named .ok source', async () => {
    makeSource('toolbox', '# Managed');
    const shared = join(root, 'shared-skills', 'toolbox');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'SKILL.md'), '---\nname: toolbox\n---\n# External');
    mkdirSync(join(root, '.codex', 'skills'), { recursive: true });
    const link = join(root, '.codex', 'skills', 'toolbox');
    symlinkSync(shared, link, 'dir');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.healed).toEqual([]);
    expect(readFileSync(join(link, 'SKILL.md'), 'utf-8')).toContain('# External');
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
  // symlink), NOT a distinct in-place skill — otherwise every managed skill
  // double-lists on each boot.
  test('frontmatter serialization-only diff → redundant (symlink), not in-place', async () => {
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
    expect(r.skipped).toEqual([]);
    expect(r.replaced).toContainEqual({ name: 'route-plan', editor: 'codex' });
    expect(isLinkToSource('.codex/skills', 'route-plan')).toBe(true);
  });

  test('additive frontmatter field (argument-hint) → redundant, not in-place', async () => {
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
    expect(r.skipped).toEqual([]);
    expect(r.replaced).toContainEqual({ name: 'dx', editor: 'cursor' });
  });

  test('a genuinely different skill sharing a source name is left in place (never moved)', async () => {
    makeSource('clash', '# OK managed version');
    makeEditorCopy('.cursor/skills', 'clash', '# A genuinely different skill');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(r.skipped).toContainEqual({ name: 'clash', editor: 'cursor' });
    // The OK-managed source is untouched.
    expect(readFileSync(join(skillsRoot, 'clash', 'SKILL.md'), 'utf-8')).toContain(
      '# OK managed version',
    );
    // The editor copy stays a real dir at its own path — never suffix-moved.
    expect(lstatSync(join(root, '.cursor', 'skills', 'clash')).isDirectory()).toBe(true);
    expect(readFileSync(join(root, '.cursor', 'skills', 'clash', 'SKILL.md'), 'utf-8')).toContain(
      '# A genuinely different skill',
    );
    expect(existsSync(join(skillsRoot, 'clash-cursor'))).toBe(false);
  });

  test('differing sibling file (scripts/) → in-place, even when SKILL.md matches', async () => {
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
    expect(r.replaced).toEqual([]);
    expect(r.skipped).toContainEqual({ name: 'gizmo', editor: 'cursor' });
  });

  test('skips a host-dir entry whose name is not a valid skill id', async () => {
    // `Invalid_Name` fails SKILL_NAME_REGEX (uppercase + underscore). Left in
    // place (not deleted) so the user can fix it manually; a valid sibling in
    // the same host dir still reconciles normally.
    makeSource('valid-skill', '# Same');
    makeEditorCopy('.codex/skills', 'Invalid_Name', '# Not a skill');
    makeEditorCopy('.codex/skills', 'valid-skill', '# Same');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(existsSync(join(skillsRoot, 'Invalid_Name'))).toBe(false);
    expect(lstatSync(join(root, '.codex', 'skills', 'Invalid_Name')).isDirectory()).toBe(true);
    // The valid sibling (a redundant copy of its source) still collapses.
    expect(r.replaced).toContainEqual({ name: 'valid-skill', editor: 'codex' });
    expect(isLinkToSource('.codex/skills', 'valid-skill')).toBe(true);
  });

  test('leaves the shipped open-knowledge bundle copy untouched', async () => {
    const bundle = makeEditorCopy('.claude/skills', 'open-knowledge', '# Shipped');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    const all = [...r.replaced, ...r.healed, ...r.skipped];
    expect(all.find((a) => a.name === 'open-knowledge')).toBeUndefined();
    // Still a real dir (copy), not a symlink.
    expect(lstatSync(bundle).isSymbolicLink()).toBe(false);
  });

  test('leaves EVERY shipped bundle copy untouched, not just open-knowledge', async () => {
    // The exclusion set is derived from the canonical bundle list, so all three
    // built-in bundle names are covered.
    const bundle = makeEditorCopy('.claude/skills', 'open-knowledge-write-skill', '# Shipped');

    const r = await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    const all = [...r.replaced, ...r.healed, ...r.skipped];
    expect(all.find((a) => a.name === 'open-knowledge-write-skill')).toBeUndefined();
    expect(existsSync(join(skillsRoot, 'open-knowledge-write-skill'))).toBe(false);
    expect(lstatSync(bundle).isSymbolicLink()).toBe(false);
  });
});

describe('reconcileSkillInstalls — accreted suffix-dupe collapse', () => {
  /** Write a `.ok/skills/<name>` source with explicit frontmatter + body. */
  function makeSourceFm(name: string, fm: string, body: string): string {
    const dir = join(skillsRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\n${body}`);
    return dir;
  }

  /** Resolve a symlink's target to an absolute path. */
  function linkTarget(linkPath: string): string {
    const raw = readlinkSync(linkPath);
    return isAbsolute(raw) ? raw : resolve(join(linkPath, '..'), raw);
  }

  test('collapses an identity-equal `<name>-<editor>` dupe and re-points its link', async () => {
    // Base + suffixed dupe: same frontmatter name + body, suffixed adds an
    // additive field only (the version-skew shape `sameSkillModuloFrontmatter`
    // now treats as identity-equal).
    makeSourceFm('foo', 'name: foo\ndescription: Use when testing.', '# Steps\n');
    makeSourceFm(
      'foo-codex',
      'name: foo\ndescription: Use when testing.\nargument-hint: x',
      '# Steps\n',
    );
    // Harness link created by the original (pre-in-place) collision suffix-adopt.
    mkdirSync(join(root, '.codex', 'skills'), { recursive: true });
    symlinkSync(join(skillsRoot, 'foo-codex'), join(root, '.codex', 'skills', 'foo-codex'), 'dir');

    await reconcileSkillInstalls({ projectDir: root, skillsRoot });

    // Suffixed source removed; base untouched.
    expect(existsSync(join(skillsRoot, 'foo-codex'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'foo', 'SKILL.md'))).toBe(true);
    // The harness link re-points at the base source (not left dangling).
    const link = join(root, '.codex', 'skills', 'foo-codex');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(resolve(linkTarget(link))).toBe(resolve(join(skillsRoot, 'foo')));
  });

  test('leaves a genuinely-different suffixed skill untouched', async () => {
    makeSourceFm('bar', 'name: bar\ndescription: Use when testing.', '# A\n');
    makeSourceFm('bar-codex', 'name: bar\ndescription: Use when testing.', '# B\n'); // different body

    await reconcileSkillInstalls({ projectDir: root, skillsRoot });

    expect(existsSync(join(skillsRoot, 'bar', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsRoot, 'bar-codex', 'SKILL.md'))).toBe(true);
  });

  test('is idempotent — a second pass with the dupe gone is a no-op', async () => {
    makeSourceFm('baz', 'name: baz\ndescription: Use when testing.', '# Steps\n');
    makeSourceFm(
      'baz-agents',
      'name: baz\ndescription: Use when testing.\nargument-hint: y',
      '# Steps\n',
    );
    await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(existsSync(join(skillsRoot, 'baz-agents'))).toBe(false);
    // Second pass: nothing left to collapse, base still intact, no throw.
    await reconcileSkillInstalls({ projectDir: root, skillsRoot });
    expect(existsSync(join(skillsRoot, 'baz', 'SKILL.md'))).toBe(true);
  });
});
