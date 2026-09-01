import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addOkPathsToGitExclude,
  formatTrackedRemediation,
  getExcludedOkPaths,
  getInstalledSkillProjectionPaths,
  getOkArtifactPaths,
  probeTrackedOkPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
} from './git-exclude.ts';

function writeMarker(dir: string, skills: Record<string, string[]>): void {
  mkdirSync(join(dir, OK_DIR, 'local'), { recursive: true });
  writeFileSync(
    join(dir, OK_DIR, 'local', 'installed-skills.json'),
    JSON.stringify({
      schema: 1,
      skills: Object.fromEntries(
        Object.entries(skills).map(([name, hosts]) => [
          name,
          { hosts, scope: 'project', scripts: false, installedAt: '2026-06-05T00:00:00.000Z' },
        ]),
      ),
    }),
    'utf-8',
  );
}

function uniqueDir(prefix: string): string {
  return resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
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

  it('returns the canonical eight-path artifact set (bundle projection carved out) when no config.yml exists', () => {
    const paths = getOkArtifactPaths(dir);
    expect(paths).toContain(`${OK_DIR}/`);
    expect(paths).toContain('.okignore');
    expect(paths).toContain('.mcp.json');
    expect(paths).toContain('.cursor/mcp.json');
    expect(paths).toContain('.codex/config.toml');
    expect(paths).toContain('opencode.json');
    expect(paths).toContain('.pi/extensions/open-knowledge.ts');
    expect(paths).toContain('.claude/launch.json');
    expect(paths).not.toContain('.claude/skills/open-knowledge/');
    expect(paths).not.toContain('.cursor/skills/open-knowledge/');
    expect(paths).not.toContain('.codex/skills/open-knowledge/');
    expect(paths).not.toContain('.github/skills/open-knowledge/');
    expect(paths).not.toContain('.opencode/skills/open-knowledge/');
    expect(paths).not.toContain('.pi/skills/open-knowledge/');
    expect(paths).toHaveLength(8);
  });

  it('preserves a stable order so `ok config-sharing status` and unit-test snapshots are deterministic', () => {
    const a = getOkArtifactPaths(dir);
    const b = getOkArtifactPaths(dir);
    expect([...a]).toEqual([...b]);
  });

  it('emits unanchored `.ok/` / `.okignore` regardless of content.dir', () => {
    mkdirSync(join(dir, OK_DIR), { recursive: true });
    writeFileSync(join(dir, OK_DIR, 'config.yml'), 'content:\n  dir: docs\n', 'utf-8');
    const paths = getOkArtifactPaths(dir);
    expect(paths).toContain('.ok/');
    expect(paths).toContain('.okignore');
    expect(paths).not.toContain('docs/.ok/');
    expect(paths).not.toContain('docs/.okignore');
    expect(paths.some((p) => p.includes('**'))).toBe(false);
    expect(paths).toHaveLength(8);
  });

  it('never excludes an AUTHORED skill projection, marker or not', () => {
    writeMarker(dir, { 'trip-log': ['claude', 'cursor', 'copilot'], 'open-knowledge': ['claude'] });
    const paths = getOkArtifactPaths(dir);
    expect(paths).not.toContain('.claude/skills/trip-log/');
    expect(paths).not.toContain('.cursor/skills/trip-log/');
    expect(paths).not.toContain('.github/skills/trip-log/');
    expect(paths).toHaveLength(8);

    const projections = getInstalledSkillProjectionPaths(dir);
    expect(projections).toContain('.claude/skills/trip-log/');
    expect(projections).toContain('.cursor/skills/trip-log/');
    expect(projections).toContain('.github/skills/trip-log/');
    expect(projections).not.toContain('.claude/skills/open-knowledge/');
  });

  it('reads the marker fail-soft — a corrupt marker yields no projections', () => {
    mkdirSync(join(dir, OK_DIR, 'local'), { recursive: true });
    writeFileSync(join(dir, OK_DIR, 'local', 'installed-skills.json'), '{ corrupt', 'utf-8');
    expect(getOkArtifactPaths(dir)).toHaveLength(8);
    expect(getInstalledSkillProjectionPaths(dir)).toEqual([]);
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
    mkdirSync(join(dir, OK_DIR), { recursive: true });
    writeFileSync(join(dir, OK_DIR, 'config.yml'), 'content:\n  dir: docs\n', 'utf-8');
    writeFileSync(join(dir, '.okignore'), '', 'utf-8');
    mkdirSync(join(dir, 'docs', 'guides', '.ok'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'guides', '.ok', 'frontmatter.yml'), '', 'utf-8');
    writeFileSync(join(dir, 'docs', 'guides', '.okignore'), '', 'utf-8');

    const result = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(result.kind).toBe('updated');

    expect(isIgnored('.ok/config.yml')).toBe(true);
    expect(isIgnored('.okignore')).toBe(true);
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

  it('writes to the linked worktree common dir, not <projectRoot>/.git/info/exclude', () => {
    const mainRepo = uniqueDir('main-repo');
    const linkedWorktree = uniqueDir('linked-worktree');
    initGitRepo(mainRepo);
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
      const dotGitContent = readFileSync(join(linkedWorktree, '.git'), 'utf-8');
      expect(dotGitContent.startsWith('gitdir:')).toBe(true);

      const result = addOkPathsToGitExclude(linkedWorktree, ['.ok/', '.mcp.json']);
      expect(result.kind).toBe('updated');

      const mainExclude = join(mainRepo, '.git', 'info', 'exclude');
      expect(existsSync(mainExclude)).toBe(true);
      const mainExcludeContent = readFileSync(mainExclude, 'utf-8');
      expect(mainExcludeContent).toContain('.ok/');
      expect(mainExcludeContent).toContain('.mcp.json');

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

  it.skipIf(process.platform === 'win32')(
    'reports an unreadable linked-worktree common-dir pointer as inaccessible',
    () => {
      rmSync(join(dir, '.git'), { recursive: true });
      const gitDir = join(dir, '.git-state');
      mkdirSync(gitDir);
      writeFileSync(join(dir, '.git'), `gitdir: ${gitDir}\n`);
      symlinkSync('commondir', join(gitDir, 'commondir'));

      expect(removeOkPathsFromGitExclude(dir, ['.ok/'])).toEqual({
        kind: 'no-exclude',
        reason: 'inaccessible',
      });
    },
  );

  it('reports the actually-removed artifact paths in `removed` (not the full candidate list)', () => {
    writeExclude(dir, '# header\n.ok/\n.mcp.json\nbuild/\n');
    const result = removeOkPathsFromGitExclude(dir, ['.ok/', '.mcp.json', '.cursor/mcp.json']);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
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
      '.cursor/mcp.json',
      '.claude/skills/open-knowledge/',
    ]);
    expect(result.tracked.sort()).toEqual(['.claude/skills/open-knowledge/', '.mcp.json']);
  });

  it('returns an empty list when no candidate is tracked', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
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
    expect(out).toContain('git rm --cached -r .claude/skills/open-knowledge');
  });

  it('warns about the teammate-side-effect of `git rm --cached`', () => {
    const out = formatTrackedRemediation(['.mcp.json']);
    expect(out).toContain('your teammates will see a deletion on their next pull');
  });
});

describe('shared -> local-only transition with tracked shareable .ok artifacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('tracked-artifact-transition-test');
    initGitRepo(dir);
    mkdirSync(join(dir, '.ok', 'schemas'), { recursive: true });
    mkdirSync(join(dir, '.ok', 'templates'), { recursive: true });
    writeFileSync(join(dir, '.ok', 'config.yml'), 'x: 1\n', 'utf-8');
    writeFileSync(join(dir, '.ok', 'schemas', 'lint.json'), '{}\n', 'utf-8');
    writeFileSync(join(dir, '.ok', 'templates', 'note.md'), '# t\n', 'utf-8');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function commitOkArtifacts(): void {
    execFileSync(
      'git',
      ['add', '.ok/config.yml', '.ok/schemas/lint.json', '.ok/templates/note.md'],
      { cwd: dir },
    );
    execFileSync('git', ['commit', '-m', 'share ok artifacts'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  }

  it('refuses via the tracked-paths probe and leaves the project shared (no silent exclude)', () => {
    commitOkArtifacts();
    writeExclude(dir, '');
    expect(readSharingMode(dir)).toBe('shared');

    const result = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(result.kind).toBe('refused-tracked');
    if (result.kind !== 'refused-tracked') throw new Error('unreachable');
    expect(result.tracked).toEqual(['.ok/']);
    expect(result.remediation).toContain('git rm --cached -r .ok');
    expect(result.remediation).toContain('your teammates will see a deletion on their next pull');
    expect(readExclude(dir)).toBe('');
    expect(readSharingMode(dir)).toBe('shared');
  });

  it('proceeds when the artifacts exist on disk but are untracked', () => {
    writeExclude(dir, '');
    const result = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(result.kind).toBe('updated');
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it('unblocks after the remediation command untracks the artifacts', () => {
    commitOkArtifacts();
    writeExclude(dir, '');
    const refused = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(refused.kind).toBe('refused-tracked');

    execFileSync('git', ['rm', '--cached', '-r', '.ok'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const retried = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(retried.kind).toBe('updated');
    expect(readSharingMode(dir)).toBe('local-only');
    expect(existsSync(join(dir, '.ok', 'config.yml'))).toBe(true);
  });
});

describe('legacy skill-projection drain (lines older builds wrote)', () => {
  it('drains stale skill lines on the way IN, so a project that stays local-only self-heals', () => {
    writeMarker(dir, { 'trip-log': ['claude'] });
    writeExclude(dir, ['.ok/', '.okignore', '.claude/skills/trip-log/', '*.tmp', ''].join('\n'));
    const result = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(result.kind).toBe('updated');
    const content = readExclude(dir);
    expect(content).not.toContain('.claude/skills/trip-log/');
    expect(content).toContain('.ok/');
    expect(content).toContain('*.tmp');
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it('outbound drain also leaves hand-written spellings alone (mirrors the inbound rule)', () => {
    writeMarker(dir, { 'trip-log': ['claude'] });
    writeExclude(
      dir,
      [
        '.ok/',
        '.claude/skills/trip-log/',
        '.claude/skills/trip-log',
        '/.claude/skills/trip-log/',
        '',
      ].join('\n'),
    );

    const result = removeOkPathsFromGitExclude(dir, getOkArtifactPaths(dir));

    expect(result.kind).toBe('updated');
    const content = readExclude(dir);
    expect(content).not.toMatch(/^\.claude\/skills\/trip-log\/$/m);
    expect(content).toMatch(/^\.claude\/skills\/trip-log$/m);
    expect(content).toMatch(/^\/\.claude\/skills\/trip-log\/$/m);
  });

  it('getExcludedOkPaths surfaces an orphaned skill line whose marker entry is gone', () => {
    writeExclude(dir, ['.ok/', '.claude/skills/ghost-skill/', ''].join('\n'));
    const excluded = getExcludedOkPaths(dir);
    expect(excluded).toContain('.claude/skills/ghost-skill/');
  });

  it('does not claim a hand-placed non-OK path as an OK exclude', () => {
    writeExclude(dir, ['.ok/', 'vendor/skills/thing/', 'notes/', ''].join('\n'));
    const excluded = getExcludedOkPaths(dir);
    expect(excluded).not.toContain('vendor/skills/thing/');
    expect(excluded).not.toContain('notes/');
  });

  it('leaves a hand-written skill exclude alone (drains only the spelling OK writes)', () => {
    writeMarker(dir, { 'trip-log': ['claude'] });
    const artifacts = getOkArtifactPaths(dir);
    writeExclude(dir, `${artifacts.join('\n')}\n.claude/skills/trip-log\n`);

    const result = addOkPathsToGitExclude(dir, artifacts);

    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    expect(result.removed).toEqual([]);
    expect(readExclude(dir)).toContain('.claude/skills/trip-log');
  });

  it('self-heals an already fully local-only project (drain with zero appends)', () => {
    writeMarker(dir, { 'trip-log': ['claude'] });
    const artifacts = getOkArtifactPaths(dir);
    writeExclude(dir, `${artifacts.join('\n')}\n.claude/skills/trip-log/\n`);

    const result = addOkPathsToGitExclude(dir, artifacts);

    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    expect(result.appended).toEqual([]);
    expect(result.removed).toEqual(['.claude/skills/trip-log/']);
    expect(readExclude(dir)).toBe(`${artifacts.join('\n')}\n`);
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it("reports the drained lines in `removed`, not just the caller's candidates", () => {
    writeMarker(dir, { 'trip-log': ['claude'] });
    writeExclude(dir, ['.ok/', '.claude/skills/trip-log/', ''].join('\n'));
    const result = removeOkPathsFromGitExclude(dir, getOkArtifactPaths(dir));
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('expected updated');
    expect(result.removed).toContain('.claude/skills/trip-log/');
    expect(result.removed).toContain('.ok/');
  });

  it('getExcludedOkPaths surfaces legacy skill lines the current set no longer names', () => {
    writeMarker(dir, { 'trip-log': ['claude'] });
    writeExclude(dir, ['.ok/', '.claude/skills/trip-log/', ''].join('\n'));
    const excluded = getExcludedOkPaths(dir);
    expect(excluded).toContain('.ok/');
    expect(excluded).toContain('.claude/skills/trip-log/');
  });

  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('legacy-drain-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('strips skill-projection lines on the switch to shared', () => {
    writeMarker(dir, { 'trip-log': ['claude'] });
    writeExclude(dir, ['.ok/', '.okignore', '.claude/skills/trip-log/', '*.tmp', ''].join('\n'));
    removeOkPathsFromGitExclude(dir, getOkArtifactPaths(dir));
    const content = readExclude(dir);
    expect(content).not.toContain('.claude/skills/trip-log/');
    expect(content).not.toContain('.ok/');
    expect(content).toContain('*.tmp');
    expect(readSharingMode(dir)).toBe('shared');
  });

  it('is a no-op when the marker is gone (nothing left to name the old lines)', () => {
    writeExclude(dir, '.ok/\n.claude/skills/trip-log/\n');
    removeOkPathsFromGitExclude(dir, getOkArtifactPaths(dir));
    const content = readExclude(dir);
    expect(content).not.toContain('.ok/');
    expect(content).toContain('.claude/skills/trip-log/');
  });
});

describe('legacy skills carve-out spelling (recognition only)', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('skills-carve-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readSharingMode reports local-only from the carve lines alone', () => {
    writeExclude(dir, '**/.ok/*\n!**/.ok/skills/\n');
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it('removeOkPaths (share) strips the carve lines so nothing is left excluding .ok/', () => {
    writeExclude(dir, '**/.ok/*\n!**/.ok/skills/\n.okignore\n');
    removeOkPathsFromGitExclude(dir, getOkArtifactPaths(dir));
    const content = readExclude(dir);
    expect(content).not.toContain('**/.ok/*');
    expect(content).not.toContain('!**/.ok/skills/');
    expect(readSharingMode(dir)).toBe('shared');
  });
});
