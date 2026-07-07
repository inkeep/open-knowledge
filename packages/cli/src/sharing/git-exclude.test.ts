import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import {
  addOkPathsToGitExclude,
  formatTrackedRemediation,
  getOkArtifactPaths,
  probeTrackedOkPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
} from './git-exclude.ts';

function uniqueDir(prefix: string): string {
  return resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  // Identity needed for any subsequent `git commit`.
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

function writeExclude(projectRoot: string, content: string): string {
  const path = join(projectRoot, '.git', 'info', 'exclude');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function readExclude(projectRoot: string): string {
  return readFileSync(join(projectRoot, '.git', 'info', 'exclude'), 'utf-8');
}

describe('getOkArtifactPaths', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('artifact-paths-test');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the canonical eleven-path artifact set when no config.yml exists', () => {
    const paths = getOkArtifactPaths(dir);
    expect(paths).toContain(`${OK_DIR}/`);
    expect(paths).toContain('.okignore');
    expect(paths).toContain('.mcp.json');
    expect(paths).toContain('.cursor/mcp.json');
    expect(paths).toContain('.codex/config.toml');
    expect(paths).toContain('opencode.json');
    expect(paths).toContain('.claude/skills/open-knowledge/');
    expect(paths).toContain('.cursor/skills/open-knowledge/');
    expect(paths).toContain('.codex/skills/open-knowledge/');
    // OpenCode installs into its own `.opencode/skills/` (its own primary dir,
    // not a shared `.agents/skills/` write), so it adds a distinct skill path on
    // top of its `opencode.json` config.
    expect(paths).toContain('.opencode/skills/open-knowledge/');
    expect(paths).toContain('.claude/launch.json');
    expect(paths).toHaveLength(11);
  });

  it('preserves a stable order so `ok config-sharing status` and unit-test snapshots are deterministic', () => {
    const a = getOkArtifactPaths(dir);
    const b = getOkArtifactPaths(dir);
    expect([...a]).toEqual([...b]);
  });

  it('emits unanchored `.ok/` / `.okignore` regardless of content.dir', () => {
    // The artifact set is content.dir-independent: a slash-free gitignore
    // entry matches at any depth, covering the project-root config dir plus
    // content-dir and folder-nested copies. Even with content.dir set to a
    // subdirectory, the entries stay unanchored — no `<contentDir>/`-prefixed
    // or `**`-nested spellings (which would miss the root `.ok/`).
    mkdirSync(join(dir, OK_DIR), { recursive: true });
    writeFileSync(join(dir, OK_DIR, 'config.yml'), 'content:\n  dir: docs\n', 'utf-8');
    const paths = getOkArtifactPaths(dir);
    expect(paths).toContain('.ok/');
    expect(paths).toContain('.okignore');
    expect(paths).not.toContain('docs/.ok/');
    expect(paths).not.toContain('docs/.okignore');
    expect(paths.some((p) => p.includes('**'))).toBe(false);
    // content.dir must not inflate the set — same eleven paths as the no-config
    // case, just never `<contentDir>`-prefixed.
    expect(paths).toHaveLength(11);
  });

  it('excludes each installed skill projection per the OF3 marker (PRD-6934 C9 fix)', () => {
    // The pre-fix set covered only the single hardcoded `open-knowledge`
    // bundle, so authored + pack skills leaked in local-only mode. With an
    // installed-skills marker present, every projection `.{host}/skills/<name>/`
    // is excluded per the hosts it was installed to.
    mkdirSync(join(dir, OK_DIR, 'local'), { recursive: true });
    writeFileSync(
      join(dir, OK_DIR, 'local', 'installed-skills.json'),
      JSON.stringify({
        schema: 1,
        skills: {
          'trip-log': {
            hosts: ['claude', 'cursor'],
            contentHash: 'abc',
            scope: 'project',
            scripts: false,
            installedAt: '2026-06-05T00:00:00.000Z',
          },
          'fishing-pack': {
            hosts: ['codex'],
            contentHash: 'def',
            scope: 'project',
            scripts: true,
            installedAt: '2026-06-05T00:00:00.000Z',
          },
        },
      }),
      'utf-8',
    );
    const paths = getOkArtifactPaths(dir);
    expect(paths).toContain('.claude/skills/trip-log/');
    expect(paths).toContain('.cursor/skills/trip-log/');
    expect(paths).toContain('.codex/skills/fishing-pack/'); // codex → .codex
    // The shipped bundle excludes remain alongside the authored ones.
    expect(paths).toContain('.claude/skills/open-knowledge/');
  });

  it('falls back to the bundle-only set when the marker is absent or corrupt', () => {
    mkdirSync(join(dir, OK_DIR, 'local'), { recursive: true });
    writeFileSync(join(dir, OK_DIR, 'local', 'installed-skills.json'), '{ corrupt', 'utf-8');
    const paths = getOkArtifactPaths(dir);
    expect(paths).toHaveLength(11); // corrupt marker → fail-soft, no per-skill paths
  });
});

describe('root + nested .ok coverage for a non-default content.dir', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('nested-exclude-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // `git check-ignore -q` exits 0 when the path is ignored, 1 otherwise.
  // Asks git's own engine whether the patterns we wrote actually hide a path.
  function isIgnored(rel: string): boolean {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', rel], {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  }

  it('excludes the ROOT `.ok/` config dir AND folder-nested `.ok/` / `.okignore` (content.dir = docs)', () => {
    // content.dir points at a subdir, but the project config still lives at the
    // ROOT `.ok/` (read from `<projectRoot>/.ok/config.yml`); folder configs
    // live nested under the content dir.
    mkdirSync(join(dir, OK_DIR), { recursive: true });
    writeFileSync(join(dir, OK_DIR, 'config.yml'), 'content:\n  dir: docs\n', 'utf-8');
    writeFileSync(join(dir, '.okignore'), '', 'utf-8');
    mkdirSync(join(dir, 'docs', 'guides', '.ok'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'guides', '.ok', 'frontmatter.yml'), '', 'utf-8');
    writeFileSync(join(dir, 'docs', 'guides', '.okignore'), '', 'utf-8');

    const result = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(result.kind).toBe('updated');

    // The root config dir — the one that actually holds config.yml — must be
    // excluded. The previous `<contentDir>/.ok/` anchoring missed it entirely.
    expect(isIgnored('.ok/config.yml')).toBe(true);
    expect(isIgnored('.okignore')).toBe(true);
    // Folder-nested copies under the content dir, too.
    expect(isIgnored('docs/guides/.ok/frontmatter.yml')).toBe(true);
    expect(isIgnored('docs/guides/.okignore')).toBe(true);
  });
});

describe('addOkPathsToGitExclude', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('add-exclude-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends fresh paths to a default exclude template', () => {
    const template = `# git ls-files --others --exclude-from=.git/info/exclude
# Lines that start with '#' are comments.
`;
    writeExclude(dir, template);

    const result = addOkPathsToGitExclude(dir, ['.ok/', '.mcp.json']);

    expect(result).toEqual({
      kind: 'updated',
      appended: ['.ok/', '.mcp.json'],
      alreadyPresent: [],
      removed: [],
    });
    const after = readExclude(dir);
    expect(after.startsWith(template)).toBe(true);
    expect(after).toMatch(/\.ok\/\n/);
    expect(after).toMatch(/\.mcp\.json\n/);
  });

  it('inserts a newline before appending when existing content has no trailing newline', () => {
    writeExclude(dir, '*.tmp');
    const result = addOkPathsToGitExclude(dir, ['.ok/']);
    expect(result.kind).toBe('updated');
    expect(readExclude(dir)).toBe('*.tmp\n.ok/\n');
  });

  it('is idempotent — running twice classifies as alreadyPresent', () => {
    writeExclude(dir, '');
    addOkPathsToGitExclude(dir, ['.ok/']);
    const second = addOkPathsToGitExclude(dir, ['.ok/']);
    expect(second).toEqual({
      kind: 'updated',
      appended: [],
      alreadyPresent: ['.ok/'],
      removed: [],
    });
    expect(readExclude(dir)).toBe('.ok/\n');
  });

  it('recognizes all four idempotence variants — `.ok`, `.ok/`, `/.ok`, `/.ok/`', () => {
    for (const variant of ['.ok', '.ok/', '/.ok', '/.ok/']) {
      writeExclude(dir, `${variant}\n`);
      const result = addOkPathsToGitExclude(dir, ['.ok/']);
      expect(result).toEqual({
        kind: 'updated',
        appended: [],
        alreadyPresent: ['.ok/'],
        removed: [],
      });
    }
  });

  it('overlaps cleanly with the clone-precedent `.ok/` line', () => {
    // Mirrors what `ensureOkExcludedFromGit` wrote before the migration:
    // bare `.ok/` on its own line. A subsequent `ok init --local-only` (or
    // `ok config-sharing unshare`) must NOT duplicate the line.
    writeExclude(dir, '.ok/\n');
    const result = addOkPathsToGitExclude(dir, [
      '.ok/',
      '.mcp.json',
      '.claude/skills/open-knowledge/',
    ]);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    expect(result.alreadyPresent).toEqual(['.ok/']);
    expect(result.appended).toEqual(['.mcp.json', '.claude/skills/open-knowledge/']);
    expect(readExclude(dir)).toBe('.ok/\n.mcp.json\n.claude/skills/open-knowledge/\n');
  });

  it('refuses when a candidate path is tracked upstream and does not write', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    writeExclude(dir, '');
    const result = addOkPathsToGitExclude(dir, ['.ok/', '.mcp.json']);
    expect(result.kind).toBe('refused-tracked');
    if (result.kind !== 'refused-tracked') throw new Error('unreachable');
    expect(result.tracked).toEqual(['.mcp.json']);
    expect(result.remediation).toContain('Cannot switch OpenKnowledge to local-only');
    expect(result.remediation).toContain('git rm --cached .mcp.json');
    // Untouched: the exclude file was not written.
    expect(readExclude(dir)).toBe('');
  });

  it('proceeds normally after the user runs `git rm --cached` on the tracked path', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['rm', '--cached', '.mcp.json'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    writeExclude(dir, '');
    const result = addOkPathsToGitExclude(dir, ['.ok/', '.mcp.json']);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    expect(result.appended.sort()).toEqual(['.mcp.json', '.ok/']);
  });

  it('returns no-exclude / no-git for non-git directories', () => {
    const nonGit = uniqueDir('non-git');
    mkdirSync(nonGit, { recursive: true });
    try {
      const result = addOkPathsToGitExclude(nonGit, ['.ok/']);
      expect(result).toEqual({ kind: 'no-exclude', reason: 'no-git' });
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('returns no-exclude / no-info-dir when the gitdir has no info/ subdir', () => {
    const noInfo = uniqueDir('no-info');
    initGitRepo(noInfo);
    try {
      rmSync(join(noInfo, '.git', 'info'), { recursive: true, force: true });
      const result = addOkPathsToGitExclude(noInfo, ['.ok/']);
      expect(result).toEqual({ kind: 'no-exclude', reason: 'no-info-dir' });
    } finally {
      rmSync(noInfo, { recursive: true, force: true });
    }
  });

  it('writes to the linked-worktree admin dir, not <projectRoot>/.git/info/exclude', () => {
    // Reproduce the worktree-blind bug: in a linked
    // worktree, <projectRoot>/.git is a regular file containing
    // `gitdir: <abs-path>`, and `info/exclude` lives under that admin dir.
    const mainRepo = uniqueDir('main-repo');
    const linkedWorktree = uniqueDir('linked-worktree');
    initGitRepo(mainRepo);
    // Need an initial commit before `git worktree add`.
    writeFileSync(join(mainRepo, 'README.md'), '# main\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: mainRepo });
    execFileSync('git', ['commit', '-m', 'init'], {
      cwd: mainRepo,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['worktree', 'add', '-b', 'feature', linkedWorktree], {
      cwd: mainRepo,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      // Sanity: the linked worktree's `.git` is a pointer file.
      const dotGitContent = readFileSync(join(linkedWorktree, '.git'), 'utf-8');
      expect(dotGitContent.startsWith('gitdir:')).toBe(true);

      const result = addOkPathsToGitExclude(linkedWorktree, ['.ok/', '.mcp.json']);
      expect(result.kind).toBe('updated');

      // `.git/info/exclude` is a per-clone artifact, not a per-worktree
      // one. The linked worktree's admin dir contains a `commondir` file
      // that resolves to `<mainRepo>/.git` — and that's where info/exclude
      // lives. Confirm we wrote there, not to a non-existent
      // <linkedWorktree>/.git/info/exclude (which the original worktree-
      // blind `ensureOkExcludedFromGit` would have silently no-op'd on).
      const mainExclude = join(mainRepo, '.git', 'info', 'exclude');
      expect(existsSync(mainExclude)).toBe(true);
      const mainExcludeContent = readFileSync(mainExclude, 'utf-8');
      expect(mainExcludeContent).toContain('.ok/');
      expect(mainExcludeContent).toContain('.mcp.json');

      // The classic worktree-blind code path would have looked at
      // <linkedWorktree>/.git/info/exclude — but here `.git` is a file,
      // not a directory, so that location doesn't exist at all.
      expect(existsSync(join(linkedWorktree, '.git', 'info', 'exclude'))).toBe(false);
    } finally {
      rmSync(linkedWorktree, { recursive: true, force: true });
      rmSync(mainRepo, { recursive: true, force: true });
    }
  });
});

describe('removeOkPathsFromGitExclude', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('remove-exclude-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes matching lines and preserves every other line byte-identical', () => {
    const original = `# user header
*.tmp
.ok/
.mcp.json
build/
.DS_Store
`;
    writeExclude(dir, original);
    removeOkPathsFromGitExclude(dir, ['.ok/', '.mcp.json']);
    const expected = `# user header
*.tmp
build/
.DS_Store
`;
    expect(readExclude(dir)).toBe(expected);
  });

  it('matches every variant on remove — `.ok`, `.ok/`, `/.ok`, `/.ok/`', () => {
    for (const variant of ['.ok', '.ok/', '/.ok', '/.ok/']) {
      writeExclude(dir, `*.tmp\n${variant}\nbuild/\n`);
      removeOkPathsFromGitExclude(dir, ['.ok/']);
      expect(readExclude(dir)).toBe('*.tmp\nbuild/\n');
    }
  });

  it('is a no-op when no OK paths are present', () => {
    const original = '*.tmp\nbuild/\n';
    writeExclude(dir, original);
    removeOkPathsFromGitExclude(dir, ['.ok/']);
    expect(readExclude(dir)).toBe(original);
  });

  it('survives a round-trip — `add` then `remove` reproduces the pre-add bytes', () => {
    const original = '# user header\n*.tmp\n';
    writeExclude(dir, original);
    addOkPathsToGitExclude(dir, ['.ok/', '.mcp.json']);
    removeOkPathsFromGitExclude(dir, ['.ok/', '.mcp.json']);
    expect(readExclude(dir)).toBe(original);
  });

  it('is tolerant of an absent exclude file', () => {
    rmSync(join(dir, '.git', 'info', 'exclude'), { force: true });
    const result = removeOkPathsFromGitExclude(dir, ['.ok/']);
    expect(result.kind).toBe('updated');
  });

  it('reports the actually-removed artifact paths in `removed` (not the full candidate list)', () => {
    writeExclude(dir, '# header\n.ok/\n.mcp.json\nbuild/\n');
    const result = removeOkPathsFromGitExclude(dir, ['.ok/', '.mcp.json', '.cursor/mcp.json']);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    // `.cursor/mcp.json` was never in the file, so it is not reported removed.
    expect(result.removed.sort()).toEqual(['.mcp.json', '.ok/']);
  });

  it('reports an empty `removed` when no candidate line was present', () => {
    writeExclude(dir, '*.tmp\nbuild/\n');
    const result = removeOkPathsFromGitExclude(dir, ['.ok/']);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    expect(result.removed).toEqual([]);
  });
});

describe('readSharingMode', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('read-mode-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns `shared` for a fresh repo with no excluded OK paths', () => {
    writeExclude(dir, '');
    expect(readSharingMode(dir)).toBe('shared');
  });

  it('returns `local-only` when EVEN ONE OK artifact path is excluded (OR-of-variants, not AND)', () => {
    // Direction-pinning test: at-least-one-variant, not all.
    writeExclude(dir, '.mcp.json\n');
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it('returns `local-only` when EVERY OK artifact path is excluded', () => {
    const paths = getOkArtifactPaths(dir);
    writeExclude(dir, `${paths.join('\n')}\n`);
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it('returns `shared` when the exclude file is missing', () => {
    rmSync(join(dir, '.git', 'info', 'exclude'), { force: true });
    expect(readSharingMode(dir)).toBe('shared');
  });

  it('returns `no-git` for a non-git directory', () => {
    const nonGit = uniqueDir('non-git-read-mode');
    mkdirSync(nonGit, { recursive: true });
    try {
      expect(readSharingMode(nonGit)).toBe('no-git');
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('ignores unrelated user lines', () => {
    writeExclude(dir, '*.tmp\n.DS_Store\nbuild/\n');
    expect(readSharingMode(dir)).toBe('shared');
  });
});

describe('probeTrackedOkPaths', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('probe-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the tracked subset, skipping paths absent on disk', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    mkdirSync(join(dir, '.claude', 'skills', 'open-knowledge'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'), 'x', 'utf-8');
    execFileSync('git', ['add', '.mcp.json', '.claude/skills/open-knowledge/SKILL.md'], {
      cwd: dir,
    });
    execFileSync('git', ['commit', '-m', 'add'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const result = probeTrackedOkPaths(dir, [
      '.mcp.json',
      '.cursor/mcp.json', // absent on disk
      '.claude/skills/open-knowledge/', // dir form
    ]);
    expect(result.tracked.sort()).toEqual(['.claude/skills/open-knowledge/', '.mcp.json']);
  });

  it('returns an empty list when no candidate is tracked', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    // Created but not committed.
    expect(probeTrackedOkPaths(dir, ['.mcp.json']).tracked).toEqual([]);
  });

  it('returns an empty list when the directory has no candidate on disk', () => {
    expect(probeTrackedOkPaths(dir, ['.mcp.json']).tracked).toEqual([]);
  });
});

describe('formatTrackedRemediation', () => {
  it('lists tracked paths and emits a `git rm --cached` for each — `-r` for dirs', () => {
    const out = formatTrackedRemediation(['.mcp.json', '.claude/skills/open-knowledge/']);
    expect(out).toContain('  .mcp.json');
    expect(out).toContain('  .claude/skills/open-knowledge/');
    expect(out).toContain('git rm --cached .mcp.json');
    // Dir form: `-r` AND trailing-slash stripped (git rm cares about the
    // path token, not the gitignore-style trailing slash).
    expect(out).toContain('git rm --cached -r .claude/skills/open-knowledge');
  });

  it('warns about the teammate-side-effect of `git rm --cached`', () => {
    const out = formatTrackedRemediation(['.mcp.json']);
    expect(out).toContain('your teammates will see a deletion on their next pull');
  });
});
