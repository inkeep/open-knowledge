import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

/** Write + git-add + commit a projected skill's SKILL.md. */
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
    // Removed from the tree — no longer tracked.
    expect(tracked(dir, '.claude/skills/open-knowledge/')).toBe(false);
    // Working file remains so the app self-heals on next open.
    expect(existsSync(join(dir, '.claude/skills/open-knowledge/SKILL.md'))).toBe(true);
    // HEAD advanced by exactly one commit whose parent is the old HEAD.
    const headAfter = git(dir, 'rev-parse', 'HEAD').trim();
    expect(headAfter).not.toBe(headBefore);
    expect(git(dir, 'rev-parse', 'HEAD^').trim()).toBe(headBefore);
    // Real index was reset to the new HEAD — no phantom STAGED addition of the
    // now-untracked file (without a `.gitignore` here git reports the working
    // file as merely untracked `??`, which is expected; a stale index would
    // instead show it staged).
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
    // Reserved bundle removed…
    expect(tracked(dir, '.claude/skills/open-knowledge/')).toBe(false);
    // …authored skill preserved.
    expect(tracked(dir, '.claude/skills/my-authored-skill/')).toBe(true);
  });

  it('is idempotent — a second call is a no-op once HEAD no longer tracks the bundle', async () => {
    initRepo(dir);
    trackSkill(dir, '.claude', 'open-knowledge', 'x\n');
    git(dir, 'commit', '-m', 'seed');

    expect((await untrackTrackedProjectSkillProjection(dir)).kind).toBe('untracked');
    const headAfterFirst = git(dir, 'rev-parse', 'HEAD').trim();
    expect((await untrackTrackedProjectSkillProjection(dir)).kind).toBe('nothing-tracked');
    // No second commit created.
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

    // The still-present working file is now ignored, so a full `git status`
    // is clean — no restamp can ever be staged again.
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
    // Left tracked — nothing committed on a detached HEAD.
    expect(tracked(dir, '.claude/skills/open-knowledge/')).toBe(true);
  });

  it('skips (operation-in-progress) when a merge is mid-flight', async () => {
    initRepo(dir);
    trackSkill(dir, '.claude', 'open-knowledge', 'x\n');
    git(dir, 'commit', '-m', 'seed');
    // Fabricate an in-progress merge marker.
    writeFileSync(join(dir, '.git', 'MERGE_HEAD'), `${git(dir, 'rev-parse', 'HEAD').trim()}\n`);
    const result = await untrackTrackedProjectSkillProjection(dir);
    expect(result).toEqual({ kind: 'skipped', reason: 'operation-in-progress' });
  });
});
