import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test, vi } from 'vitest';
import { withTempDir } from '../../../../test-support/temp-dir.test-helper.ts';
import { applySkillWrite } from './skills-write.ts';

vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>();
  return { ...path, relative: path.win32.relative, sep: path.win32.sep };
});

test.each(['.git', '.git/hooks', '.git/skills/helper', '.ok/local'])(
  'Win32 relative paths refuse a skill root linked into %s',
  async (target) => {
    await withTempDir('ok-skill-win32-', async (root) => {
      const boundary = join(root, 'project');
      const skillsRoot = join(boundary, '.claude/skills');
      const privateDir = join(boundary, target);
      mkdirSync(privateDir, { recursive: true });
      mkdirSync(skillsRoot, { recursive: true });
      writeFileSync(join(privateDir, 'sentinel.txt'), 'private sentinel');
      symlinkSync(privateDir, join(skillsRoot, 'helper'), 'junction');
      expect(relative(boundary, privateDir)).toBe(target.replaceAll('/', '\\'));

      const result = applySkillWrite({
        boundary,
        skillsRoot,
        name: 'helper',
        body: 'Replacement',
        frontmatter: { name: 'helper', description: 'Fixture' },
      });

      expect(result).toMatchObject({ ok: false, error: { code: 'SKILL_PATH_PRIVATE_STATE' } });
      expect(existsSync(join(privateDir, 'SKILL.md'))).toBe(false);
      expect(readFileSync(join(privateDir, 'sentinel.txt'), 'utf8')).toBe('private sentinel');
    });
  },
);
