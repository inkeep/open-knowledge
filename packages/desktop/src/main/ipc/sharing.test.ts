
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleSharingSetMode, handleSharingStatus } from './sharing.ts';

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
