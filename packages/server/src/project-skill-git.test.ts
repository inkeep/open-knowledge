import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureProjectSkillGitignore } from './init-project.ts';
import { untrackTrackedProjectSkillProjection } from './project-skill-git.ts';

function uniqueDir(prefix: string): string {
  return resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
}

function trackSkill(dir: string, hostRel: string, skillName: string, body: string): void {
  const rel = join(hostRel, 'skills', skillName, 'SKILL.md');
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
  git(dir, 'add', '--', rel);
}

function tracked(dir: string, pathspec: string): boolean {
  return git(dir, 'ls-files', '--', pathspec).trim().length > 0;
}

describe('untrackTrackedProjectSkillProjection', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('untrack-skill-test');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('untracks an already-tracked built-in projection and advances HEAD, keeping the working file', async () => {
    initRepo(dir);
    trackSkill(dir, '.claude', 'open-knowledge', '---\nmetadata:\n  version: 1.0.0\n---\nbody\n');
    git(dir, 'commit', '-m', 'seed');
    const headBefore = git(dir, 'rev-parse', 'HEAD').trim();
    expect(tracked(dir, '.claude/skills/open-knowledge/')).toBe(true);

    const result = await untrackTrackedProjectSkillProjection(dir);

    expect(result.kind).toBe('untracked');
    if (result.kind !== 'untracked') throw new Error('unreachable');
    expect(result.dirs).toContain('.claude/skills/open-knowledge');
    expect(tracked(dir, '.claude/skills/open-knowledge/')).toBe(false);
    expect(existsSync(join(dir, '.claude/skills/open-knowledge/SKILL.md'))).toBe(true);
    const headAfter = git(dir, 'rev-parse', 'HEAD').trim();
    expect(headAfter).not.toBe(headBefore);
    expect(git(dir, 'rev-parse', 'HEAD^').trim()).toBe(headBefore);
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('');
  });

  it('untracks every editor-host projection at once', async () => {
    initRepo(dir);
    trackSkill(dir, '.claude', 'open-knowledge', 'a\n');
    trackSkill(dir, '.cursor', 'open-knowledge', 'b\n');
    trackSkill(dir, '.codex', 'open-knowledge', 'c\n');
    git(dir, 'commit', '-m', 'seed');

    const result = await untrackTrackedProjectSkillProjection(dir);

    expect(result.kind).toBe('untracked');
    expect(tracked(dir, '.claude/skills/open-knowledge/')).toBe(false);
    expect(tracked(dir, '.cursor/skills/open-knowledge/')).toBe(false);
    expect(tracked(dir, '.codex/skills/open-knowledge/')).toBe(false);
  });

  it('is skill-name-scoped — an authored skill at `.{host}/skills/<other>/` is NOT untracked', async () => {
    initRepo(dir);
    trackSkill(dir, '.claude', 'open-knowledge', 'bundle\n');
    trackSkill(dir, '.claude', 'my-authored-skill', 'authored\n');
    git(dir, 'commit', '-m', 'seed');

    const result = await untrackTrackedProjectSkillProjection(dir);

    expect(result.kind).toBe('untracked');
    expect(tracked(dir, '.claude/skills/open-knowledge/')).toBe(false);
    expect(tracked(dir, '.claude/skills/my-authored-skill/')).toBe(true);
  });

  it('is idempotent — a second call is a no-op once HEAD no longer tracks the bundle', async () => {
    initRepo(dir);
    trackSkill(dir, '.claude', 'open-knowledge', 'x\n');
    git(dir, 'commit', '-m', 'seed');

    expect((await untrackTrackedProjectSkillProjection(dir)).kind).toBe('untracked');
    const headAfterFirst = git(dir, 'rev-parse', 'HEAD').trim();
    expect((await untrackTrackedProjectSkillProjection(dir)).kind).toBe('nothing-tracked');
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(headAfterFirst);
  });

  it('combined with ensureProjectSkillGitignore, leaves the regenerated file ignored + clean', async () => {
    initRepo(dir);
    trackSkill(dir, '.claude', 'open-knowledge', 'x\n');
    git(dir, 'commit', '-m', 'seed');

    ensureProjectSkillGitignore(dir);
    git(dir, 'add', '--', '.gitignore');
    git(dir, 'commit', '-m', 'gitignore');
    await untrackTrackedProjectSkillProjection(dir);

    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
    expect(git(dir, 'check-ignore', '--', '.claude/skills/open-knowledge/SKILL.md').trim()).toBe(
      '.claude/skills/open-knowledge/SKILL.md',
    );
  });

  it('returns nothing-tracked when the projection is untracked', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'README.md'), '# r\n', 'utf-8');
    git(dir, 'add', '--', 'README.md');
    git(dir, 'commit', '-m', 'init');
    expect((await untrackTrackedProjectSkillProjection(dir)).kind).toBe('nothing-tracked');
  });

  it('skips (no-git) a non-git directory', async () => {
    mkdirSync(dir, { recursive: true });
    const result = await untrackTrackedProjectSkillProjection(dir);
    expect(result).toEqual({ kind: 'skipped', reason: 'no-git' });
  });

  it('skips (detached-head) when HEAD is detached', async () => {
    initRepo(dir);
    trackSkill(dir, '.claude', 'open-knowledge', 'x\n');
    git(dir, 'commit', '-m', 'seed');
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '--detach', sha);
    const result = await untrackTrackedProjectSkillProjection(dir);
    expect(result).toEqual({ kind: 'skipped', reason: 'detached-head' });
    expect(tracked(dir, '.claude/skills/open-knowledge/')).toBe(true);
  });

  it('skips (operation-in-progress) when a merge is mid-flight', async () => {
    initRepo(dir);
    trackSkill(dir, '.claude', 'open-knowledge', 'x\n');
    git(dir, 'commit', '-m', 'seed');
    writeFileSync(join(dir, '.git', 'MERGE_HEAD'), `${git(dir, 'rev-parse', 'HEAD').trim()}\n`);
    const result = await untrackTrackedProjectSkillProjection(dir);
    expect(result).toEqual({ kind: 'skipped', reason: 'operation-in-progress' });
  });
});
