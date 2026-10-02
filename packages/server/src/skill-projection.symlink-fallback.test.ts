import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS_SKILLS_ROOT } from '@inkeep/open-knowledge-core';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSkillPlacementOpsService } from './services/skill-placement-ops.ts';
import { projectInPlaceSkill, projectSkill } from './skill-projection.ts';

const symlinkFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock('./fs-traced.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fs-traced.ts')>();
  return {
    ...actual,
    tracedSymlinkSync: (...args: Parameters<typeof actual.tracedSymlinkSync>): void => {
      if (symlinkFailure.code !== undefined) {
        throw Object.assign(new Error(`${symlinkFailure.code}: operation not permitted, symlink`), {
          code: symlinkFailure.code,
          syscall: 'symlink',
        });
      }
      actual.tracedSymlinkSync(...args);
    },
  };
});

let cwd: string;

function makeCanonical(name: string): string {
  const dir = join(cwd, AGENTS_SKILLS_ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nBody.\n`);
  return dir;
}

function isRealDirWithSkill(path: string): boolean {
  return (
    existsSync(join(path, 'SKILL.md')) &&
    !lstatSync(path).isSymbolicLink() &&
    lstatSync(path).isDirectory()
  );
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ok-symlink-fallback-'));
  symlinkFailure.code = undefined;
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('projection when symlinks are not permitted', () => {
  test.each(['EPERM', 'EACCES'])('projectSkill falls back to a copy on %s', (code) => {
    const src = makeCanonical('demo');
    symlinkFailure.code = code;
    expect(projectSkill(src, 'demo', cwd, ['claude'])).toEqual(['claude']);
    expect(isRealDirWithSkill(join(cwd, '.claude', 'skills', 'demo'))).toBe(true);
  });

  test('projectSkill still throws other symlink failures', () => {
    const src = makeCanonical('demo');
    symlinkFailure.code = 'ENOSPC';
    expect(() => projectSkill(src, 'demo', cwd, ['claude'])).toThrow('ENOSPC');
  });

  test.each(['EPERM', 'EACCES'])('projectInPlaceSkill link falls back to a copy on %s', (code) => {
    const canonicalAbs = makeCanonical('demo');
    symlinkFailure.code = code;
    const result = projectInPlaceSkill({
      canonicalAbs,
      canonicalHash: parseSkillDir(canonicalAbs)?.contentHash ?? '',
      canonicalRootRel: AGENTS_SKILLS_ROOT,
      name: 'demo',
      cwd,
      targets: ['claude'],
      mode: 'link',
    });
    expect(result.hosts).toContain('claude');
    expect(isRealDirWithSkill(join(cwd, '.claude', 'skills', 'demo'))).toBe(true);
  });

  test('converting a copy to a link keeps the copy and says why', async () => {
    const canonicalAbs = makeCanonical('demo');
    const copy = join(cwd, '.claude', 'skills', 'demo');
    cpSync(canonicalAbs, copy, { recursive: true });
    symlinkFailure.code = 'EPERM';
    const outcome = await createSkillPlacementOpsService().convert({
      ledgerBase: cwd,
      scope: 'project',
      name: 'demo',
      target: 'claude',
      mode: 'link',
      skillDir: canonicalAbs,
      canonicalHash: parseSkillDir(canonicalAbs)?.contentHash ?? '',
    });
    expect(outcome).toEqual({ ok: false, kind: 'links-not-permitted' });
    expect(isRealDirWithSkill(copy)).toBe(true);
  });
});
