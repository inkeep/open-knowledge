import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  applySkillBundleFileDelete,
  applySkillBundleFileRename,
  applySkillBundleFileWrite,
  applySkillWrite,
} from './skills-write.ts';

let fixture: string;
let boundary: string;
let skillsRoot: string;
let outside: string;

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ok-skill-mutations-')));
  boundary = join(fixture, 'project');
  skillsRoot = join(boundary, '.claude/skills');
  outside = join(fixture, 'outside');
  mkdirSync(join(skillsRoot, 'helper'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(skillsRoot, 'helper/SKILL.md'), '# Helper');
  writeFileSync(join(outside, 'sentinel.txt'), 'outside sentinel');
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

test.each(['write', 'delete', 'rename-from', 'rename-to'] as const)(
  '%s refuses a nested parent link at the shared mutation boundary',
  (operation) => {
    symlinkSync(outside, join(skillsRoot, 'helper/assets'), 'dir');
    const input = { boundary, skillsRoot, name: 'helper', relPath: 'assets/sentinel.txt' };
    writeFileSync(join(skillsRoot, 'helper/local.txt'), 'local sentinel');
    const result =
      operation === 'write'
        ? applySkillBundleFileWrite({ ...input, content: 'replacement' })
        : operation === 'delete'
          ? applySkillBundleFileDelete(input)
          : applySkillBundleFileRename({
              ...input,
              ...(operation === 'rename-to'
                ? { relPath: 'local.txt', toRelPath: 'assets/new.txt' }
                : { toRelPath: 'moved.txt' }),
            });
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside sentinel');
    expect(readFileSync(join(skillsRoot, 'helper/local.txt'), 'utf8')).toBe('local sentinel');
    expect(result.ok).toBe(false);
  },
);

test('skill writes refuse an escaping host ancestor', () => {
  rmSync(join(boundary, '.claude'), { recursive: true });
  symlinkSync(outside, join(boundary, '.claude'), 'dir');
  const input = {
    boundary,
    skillsRoot,
    name: 'helper',
    body: '# Replacement',
    frontmatter: { name: 'helper', description: 'Fixture' },
  };
  expect(applySkillWrite(input).ok).toBe(false);
  expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside sentinel');
});

test('bundle deletion refuses a skill root linked outside the project', () => {
  rmSync(join(skillsRoot, 'helper'), { recursive: true });
  symlinkSync(outside, join(skillsRoot, 'helper'), 'dir');
  expect(
    applySkillBundleFileDelete({ boundary, skillsRoot, name: 'helper', relPath: 'sentinel.txt' })
      .ok,
  ).toBe(false);
  expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside sentinel');
});

test.each(['sentinel.txt', 'missing.txt'])('bundle writes refuse a %s leaf symlink', (target) => {
  symlinkSync(join(outside, target), join(skillsRoot, 'helper/linked.txt'), 'file');
  expect(
    applySkillBundleFileWrite({
      boundary,
      skillsRoot,
      name: 'helper',
      relPath: 'linked.txt',
      content: 'replacement',
    }).ok,
  ).toBe(false);
  expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside sentinel');
});

test('a linked root inside the project cannot target private Git state', () => {
  const gitDir = join(boundary, '.git');
  mkdirSync(gitDir);
  writeFileSync(join(gitDir, 'config'), 'private sentinel');
  rmSync(join(skillsRoot, 'helper'), { recursive: true });
  symlinkSync(gitDir, join(skillsRoot, 'helper'), 'dir');

  expect(
    applySkillWrite({
      boundary,
      skillsRoot,
      name: 'helper',
      body: 'Replacement',
      frontmatter: { name: 'helper', description: 'Fixture' },
    }).ok,
  ).toBe(false);
  expect(readFileSync(join(gitDir, 'config'), 'utf8')).toBe('private sentinel');
  expect(existsSync(join(gitDir, 'SKILL.md'))).toBe(false);
});

test('unverifiable bundle paths preserve their lookup errno', () => {
  writeFileSync(join(skillsRoot, 'helper/assets'), 'not a directory');
  const result = applySkillBundleFileWrite({
    boundary,
    skillsRoot,
    name: 'helper',
    relPath: 'assets/sentinel.txt',
    content: 'replacement',
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'SKILL_PATH_CHECK_FAILED' } });
  if (!result.ok) expect(result.error.message).toContain('ENOTDIR');
  expect(readFileSync(join(skillsRoot, 'helper/assets'), 'utf8')).toBe('not a directory');
});

test('a skill-directory lookup failure names the directory rather than a file component', () => {
  rmSync(join(skillsRoot, 'helper'), { recursive: true });
  symlinkSync('helper', join(skillsRoot, 'helper'), 'dir');
  const result = applySkillWrite({
    boundary,
    skillsRoot,
    name: 'helper',
    body: 'Replacement',
    frontmatter: { name: 'helper', description: 'Fixture' },
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'SKILL_PATH_CHECK_FAILED' } });
  if (!result.ok) {
    expect(result.error.message).toContain('skill directory');
    expect(result.error.message).toContain('ELOOP');
  }
});
