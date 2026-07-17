/**
 * IPC handler tests for the `ok:sharing:dispatch` channel (status / set-mode /
 * set-skills-shared).
 *
 * Exercise the pure handler functions directly against a tmpdir-backed git
 * repo. The IPC wrapping in main/index.ts is one createHandler call; its
 * behavior (look up ctx, throw on no-ctx, forward projectPath) is shared
 * with every project-scoped IPC and is covered by the existing main-side
 * tests for those siblings.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  handleSharingSetMode,
  handleSharingSetSkillsShared,
  handleSharingStatus,
} from './sharing.ts';

function uniqueDir(prefix: string): string {
  return resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
}

describe('handleSharingStatus', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('sharing-status-handler');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports `shared` for a fresh repo', () => {
    const result = handleSharingStatus(dir);
    expect(result.mode).toBe('shared');
    expect(result.excluded).toEqual([]);
    expect(result.trackedUpstream).toEqual([]);
  });

  it('flips to `local-only` after a setMode toggle', () => {
    const set = handleSharingSetMode(dir, 'local-only');
    expect(set.kind).toBe('applied');
    if (set.kind !== 'applied') throw new Error('expected applied');
    expect(set.mode).toBe('local-only');
    const status = handleSharingStatus(dir);
    expect(status.mode).toBe('local-only');
    expect(status.excluded.length).toBeGreaterThan(0);
  });

  it('lists tracked-upstream OK paths', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const status = handleSharingStatus(dir);
    expect(status.trackedUpstream).toEqual(['.mcp.json']);
  });

  it('reports `no-git` for a non-git directory', () => {
    const nonGit = uniqueDir('sharing-status-nongit-handler');
    mkdirSync(nonGit, { recursive: true });
    try {
      expect(handleSharingStatus(nonGit).mode).toBe('no-git');
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe('handleSharingSetMode', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('sharing-set-mode-handler');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns `refused-tracked` when an OK path is tracked upstream', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const result = handleSharingSetMode(dir, 'local-only');
    expect(result.kind).toBe('refused-tracked');
    if (result.kind !== 'refused-tracked') throw new Error('expected refused');
    expect(result.tracked).toEqual(['.mcp.json']);
    expect(result.remediation).toContain('git rm --cached');
  });

  it('round-trips shared → local-only → shared cleanly', () => {
    expect(handleSharingStatus(dir).mode).toBe('shared');
    handleSharingSetMode(dir, 'local-only');
    expect(handleSharingStatus(dir).mode).toBe('local-only');
    handleSharingSetMode(dir, 'shared');
    expect(handleSharingStatus(dir).mode).toBe('shared');
    // Exclude file (created by git init) should not retain any OK markers.
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).not.toContain('.ok/');
    expect(exclude).not.toContain('.mcp.json');
  });

  it('returns `no-exclude` / `no-git` for a non-git directory', () => {
    const nonGit = uniqueDir('sharing-set-mode-nongit');
    mkdirSync(nonGit, { recursive: true });
    try {
      const result = handleSharingSetMode(nonGit, 'local-only');
      expect(result).toMatchObject({ kind: 'no-exclude', reason: 'no-git' });
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe('handleSharingSetSkillsShared (local-only skills carve-out)', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('sharing-skills-handler');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('carves skills out of a local-only project and reports it in status', () => {
    handleSharingSetMode(dir, 'local-only');
    expect(handleSharingStatus(dir).skillsShared).toBe(false);

    const result = handleSharingSetSkillsShared(dir, true);
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error('expected applied');
    // Still local-only for the rest of .ok/ — only skills were carved out.
    expect(result.mode).toBe('local-only');

    const status = handleSharingStatus(dir);
    expect(status.mode).toBe('local-only');
    expect(status.skillsShared).toBe(true);
  });

  it('turning skills sharing back off restores full local-only', () => {
    handleSharingSetMode(dir, 'local-only');
    handleSharingSetSkillsShared(dir, true);
    handleSharingSetSkillsShared(dir, false);
    const status = handleSharingStatus(dir);
    expect(status.mode).toBe('local-only');
    expect(status.skillsShared).toBe(false);
  });

  it('actually unhides .ok/skills while keeping .ok/local hidden from git', () => {
    mkdirSync(join(dir, '.ok', 'skills', 's'), { recursive: true });
    mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
    writeFileSync(join(dir, '.ok', 'skills', 's', 'SKILL.md'), '# s\n', 'utf-8');
    writeFileSync(join(dir, '.ok', 'local', 'state.json'), '{}\n', 'utf-8');

    handleSharingSetMode(dir, 'local-only');
    handleSharingSetSkillsShared(dir, true);

    const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    expect(untracked).toContain('.ok/skills/s/SKILL.md');
    expect(untracked).not.toContain('.ok/local/state.json');
  });

  it('returns `no-exclude` / `no-git` for a non-git directory', () => {
    const nonGit = uniqueDir('sharing-skills-nongit');
    mkdirSync(nonGit, { recursive: true });
    try {
      const result = handleSharingSetSkillsShared(nonGit, true);
      expect(result).toMatchObject({ kind: 'no-exclude', reason: 'no-git' });
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
