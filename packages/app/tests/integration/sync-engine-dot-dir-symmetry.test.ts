import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContentFilter } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import { SyncEngine } from '../../../server/src/sync-engine.ts';

const tmpRoots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(): { projectDir: string; originDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-sync-dotdir-repo-'));
  const originDir = mkdtempSync(join(tmpdir(), 'ok-sync-dotdir-origin-'));
  tmpRoots.push(projectDir, originDir);

  git(projectDir, ['init', '-b', 'main']);
  git(projectDir, ['config', 'user.name', 'Test User']);
  git(projectDir, ['config', 'user.email', 'test@example.com']);
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
  mkdirSync(join(projectDir, '.cursor', 'skills', 'open-knowledge'), { recursive: true });
  writeFileSync(
    join(projectDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'),
    '# OpenKnowledge Skill\n',
    'utf-8',
  );
  writeFileSync(join(projectDir, 'regular.md'), '# Regular\n', 'utf-8');
  git(projectDir, ['add', '.']);
  git(projectDir, ['commit', '-m', 'seed dot-dir skill']);

  git(originDir, ['init', '--bare', '-b', 'main']);
  git(projectDir, ['remote', 'add', 'origin', originDir]);
  git(projectDir, ['push', '--set-upstream', 'origin', 'main']);
  return { projectDir, originDir };
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sync-engine dot-dir filter symmetry', () => {
  test('push cycle does not commit a deletion for tracked markdown under .cursor/skills', async () => {
    const { projectDir } = makeRepo();
    const headBefore = git(projectDir, ['rev-parse', 'HEAD']);
    const skillPath = '.cursor/skills/open-knowledge/SKILL.md';

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: createContentFilter({ projectDir, contentDir: projectDir }),
      contentRoot: '.',
      syncEnabled: true,
    });

    await (
      engine as unknown as { doPushCycle: (retriesLeft?: number) => Promise<void> }
    ).doPushCycle(0);

    const headAfter = git(projectDir, ['rev-parse', 'HEAD']);
    expect(headAfter).toBe(headBefore);
    expect(git(projectDir, ['cat-file', '-e', `HEAD:${skillPath}`])).toBe('');
    expect(git(projectDir, ['status', '--porcelain', '--', skillPath])).toBe('');
  });
});
