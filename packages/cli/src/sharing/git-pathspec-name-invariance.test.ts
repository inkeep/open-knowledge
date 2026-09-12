import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeTrackedOkPaths } from './git-exclude.ts';

let projectRoot = '';

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeSkillFile(name: string, body: string): string {
  const rel = `.ok/skills/${name}/SKILL.md`;
  mkdirSync(join(projectRoot, '.ok', 'skills', name), { recursive: true });
  writeFileSync(join(projectRoot, rel), body, 'utf-8');
  return rel;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'ok-cli-pathspec-'));
  git(['init', '-q', '-b', 'main', '.']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@test.com']);
  writeFileSync(join(projectRoot, 'README.md'), '# seed\n', 'utf-8');
  git(['add', '--', 'README.md']);
  git(['commit', '-qm', 'seed']);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('probeTrackedOkPaths — pathspec name invariance (site 14)', () => {
  it('does not report an untracked wildcard-named skill file as tracked', () => {
    const trackedSibling = writeSkillFile('starfish', '# starfish\n');
    git(['add', '--', trackedSibling]);
    git(['commit', '-qm', 'track the sibling skill']);

    const untracked = writeSkillFile('star*', '# wildcard\n');

    expect(probeTrackedOkPaths(projectRoot, [untracked])).toEqual({ tracked: [] });
  });

  it('reports a tracked wildcard-named skill file as tracked', () => {
    const wildcard = writeSkillFile('star*', '# wildcard\n');
    git(['add', '--', `:(literal)${wildcard}`]);
    git(['commit', '-qm', 'track the wildcard skill']);

    expect(probeTrackedOkPaths(projectRoot, [wildcard])).toEqual({ tracked: [wildcard] });
  });
});
