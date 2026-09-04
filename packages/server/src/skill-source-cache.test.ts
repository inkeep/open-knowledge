import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkillDirs,
  parseSkillDir,
  type SourceSpec,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { clearSourceCache, fetchCachedSource } from './skill-source-cache.ts';

interface SkillFixture {
  dir: string;
  name: string;
  description: string;
  body?: string;
}

function skillMd(f: SkillFixture): string {
  return [
    '---',
    `name: ${f.name}`,
    `description: ${f.description}`,
    '---',
    '',
    f.body ?? 'Body.',
    '',
  ].join('\n');
}

function makeGitRepo(skills: SkillFixture[]): string {
  const repo = mkdtempSync(join(tmpdir(), 'ok-source-cache-repo-'));
  for (const s of skills) {
    const d = join(repo, s.dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), skillMd(s));
  }
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return repo;
}

const gitSpec = (repo: string): SourceSpec => ({ kind: 'git', url: repo });

function skillNames(dir: string): string[] {
  return discoverSkillDirs(dir)
    .map((d) => parseSkillDir(d.dir)?.name)
    .filter((n): n is string => typeof n === 'string')
    .sort();
}

describe('fetchCachedSource', () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await clearSourceCache();
    for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (skills: SkillFixture[]): string => {
    const r = makeGitRepo(skills);
    cleanupDirs.push(r);
    return r;
  };

  test('two sibling skills from one source clone the repo once', async () => {
    const src = repo([
      { dir: 'alpha', name: 'alpha', description: 'A' },
      { dir: 'beta', name: 'beta', description: 'B' },
    ]);
    const first = await fetchCachedSource(gitSpec(src));
    const second = await fetchCachedSource(gitSpec(src));
    expect(second.dir).toBe(first.dir);
    expect(skillNames(first.dir)).toEqual(['alpha', 'beta']);
  });

  test('concurrent sibling requests dedupe onto one in-flight clone', async () => {
    const src = repo([{ dir: 'alpha', name: 'alpha', description: 'A' }]);
    const [a, b] = await Promise.all([
      fetchCachedSource(gitSpec(src)),
      fetchCachedSource(gitSpec(src)),
    ]);
    expect(b.dir).toBe(a.dir);
  });

  test('distinct sources do not collide', async () => {
    const one = repo([{ dir: 'one', name: 'skill-one', description: 'One' }]);
    const two = repo([{ dir: 'two', name: 'skill-two', description: 'Two' }]);
    const a = await fetchCachedSource(gitSpec(one));
    const b = await fetchCachedSource(gitSpec(two));
    expect(a.dir).not.toBe(b.dir);
    expect(skillNames(a.dir)).toEqual(['skill-one']);
    expect(skillNames(b.dir)).toEqual(['skill-two']);
  });

  test('the clone path resolves a real commit sha and clearing removes the clone', async () => {
    const src = repo([{ dir: 'alpha', name: 'alpha', description: 'A' }]);
    const fetched = await fetchCachedSource(gitSpec(src));
    expect(fetched.ref).toMatch(/^[0-9a-f]{40}$/);
    const clonedDir = fetched.dir;
    expect(existsSync(clonedDir)).toBe(true);
    fetched.cleanup();
    expect(existsSync(clonedDir)).toBe(true);
    await clearSourceCache();
    expect(existsSync(clonedDir)).toBe(false);
  });

  test('an entry past the TTL is swept, its clone removed, and the next call re-clones', async () => {
    const src = repo([{ dir: 'alpha', name: 'alpha', description: 'A' }]);
    const first = await fetchCachedSource(gitSpec(src));
    const clonedDir = first.dir;
    expect(existsSync(clonedDir)).toBe(true);

    vi.useFakeTimers({ toFake: ['Date'] });
    let second: Awaited<ReturnType<typeof fetchCachedSource>>;
    try {
      vi.setSystemTime(Date.now() + 31_000);
      second = await fetchCachedSource(gitSpec(src));
    } finally {
      vi.useRealTimers();
    }

    expect(second.dir).not.toBe(clonedDir);
    expect(skillNames(second.dir)).toEqual(['alpha']);
    await vi.waitFor(() => expect(existsSync(clonedDir)).toBe(false));
  });

  test('local sources bypass the cache and read in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-source-cache-local-'));
    cleanupDirs.push(dir);
    mkdirSync(join(dir, 'x'), { recursive: true });
    writeFileSync(join(dir, 'x', 'SKILL.md'), skillMd({ dir: 'x', name: 'x', description: 'X' }));
    const fetched = await fetchCachedSource({ kind: 'local', path: dir });
    expect(fetched.dir).toBe(dir);
    expect(fetched.ref).toBeUndefined();
  });

  test('a failed clone rejects without wedging the cache for other sources', async () => {
    const missing = join(tmpdir(), 'ok-source-cache-nonexistent-xyz');
    await expect(fetchCachedSource(gitSpec(missing))).rejects.toThrow();
    const src = repo([{ dir: 'alpha', name: 'alpha', description: 'A' }]);
    const ok = await fetchCachedSource(gitSpec(src));
    expect(skillNames(ok.dir)).toEqual(['alpha']);
  });
});
