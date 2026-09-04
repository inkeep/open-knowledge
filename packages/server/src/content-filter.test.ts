import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type ContentFilter,
  createContentFilter,
  createContentFilterAsync,
} from './content-filter.ts';
import { installTestLoggers, loggerFactory } from './logger.ts';

type ExclusionReadOpts = NonNullable<Parameters<ContentFilter['isExcluded']>[1]>;
type PathReadOpts = NonNullable<Parameters<ContentFilter['isPathIgnored']>[1]>;

// @ts-expect-error — sync admission and Show All Files are mutually exclusive.
const _combinedSyncAndBypass: ExclusionReadOpts = {
  bypassFilters: true,
  syncScope: { pathBase: 'project' },
};
// @ts-expect-error — asset serving never accepts the sync-only capability.
const _syncScopedAssetServe: PathReadOpts = { syncScope: { pathBase: 'project' } };
void _combinedSyncAndBypass;
void _syncScopedAssetServe;

describe('ContentFilter', () => {
  let projectDir: string;
  let xdgDir: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'content-filter-test-'));
    xdgDir = await mkdtemp(join(tmpdir(), 'content-filter-xdg-'));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgDir;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    await rm(projectDir, { recursive: true, force: true });
    await rm(xdgDir, { recursive: true, force: true });
  });

  describe('sync-popover open-target admission', () => {
    const openable = (filter: ContentFilter, relPath: string): boolean =>
      !filter.isExcluded(relPath, { bypassFilters: true, showOk: true });

    test('admits the config and dotfiles the sidebar shows', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'ignored-note.md\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(openable(filter, 'opencode.json')).toBe(true);
      expect(openable(filter, '.gitignore')).toBe(true);
      expect(openable(filter, '.ok/config.yml')).toBe(true);
      expect(openable(filter, '.claude/skills/reviewer/SKILL.md')).toBe(false);
      expect(openable(filter, 'ignored-note.md')).toBe(true);
    });

    test('refuses the floors — secrets first', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(openable(filter, '.env')).toBe(false);
      expect(openable(filter, '.env.local')).toBe(false);
      expect(openable(filter, 'deploy/prod.pem')).toBe(false);
      expect(openable(filter, '.ssh/id_rsa')).toBe(false);
      expect(openable(filter, '.aws/credentials')).toBe(false);
      expect(openable(filter, '.ok/local/server.lock')).toBe(false);
      expect(openable(filter, '.git/config')).toBe(false);
      expect(openable(filter, 'node_modules/pkg/index.js')).toBe(false);
    });
  });

  describe('gitignore filtering', () => {
    test('excludes files matching .gitignore patterns', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\ntmp/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('dist/output.md')).toBe(true);
      expect(filter.isExcluded('tmp/scratch.md')).toBe(true);
      expect(filter.isExcluded('docs/readme.md')).toBe(false);
    });

    test('excludes .git directory even without .gitignore', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('.git/objects/readme.md')).toBe(true);
    });

    test('respects gitignore negation patterns', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'logs/*\n!logs/important.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('logs/debug.md')).toBe(true);
      expect(filter.isExcluded('logs/important.md')).toBe(false);
    });

    test('handles wildcard patterns in .gitignore', () => {
      writeFileSync(join(projectDir, '.gitignore'), '*.log\nbuild-*\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('error.log')).toBe(true);
      expect(filter.isExcluded('docs/guide.md')).toBe(false);
    });
  });

  describe('.okignore filtering', () => {
    test('excludes files matching root .okignore patterns', () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('drafts/wip.md')).toBe(true);
      expect(filter.isExcluded('docs/guide.md')).toBe(false);
    });

    test('cross-source negation — .okignore !pattern overrides .gitignore exclusion', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'secret.md\n');
      writeFileSync(join(projectDir, '.okignore'), '!secret.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('secret.md')).toBe(false);
    });

    test('nested .okignore at folder depth applies patterns with correct path prefix', () => {
      mkdirSync(join(projectDir, 'subdir'), { recursive: true });
      writeFileSync(join(projectDir, 'subdir', '.okignore'), 'private.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('subdir/private.md')).toBe(true);
      expect(filter.isExcluded('private.md')).toBe(false);
    });

    test('mixed nested .gitignore + .okignore are both honored', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, 'docs', '.gitignore'), 'build/\n');
      writeFileSync(join(projectDir, 'docs', '.okignore'), 'wip/\n');
      mkdirSync(join(projectDir, 'docs', 'build'), { recursive: true });
      mkdirSync(join(projectDir, 'docs', 'wip'), { recursive: true });

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('docs/build/output.md')).toBe(true);
      expect(filter.isExcluded('docs/wip/draft.md')).toBe(true);
      expect(filter.isExcluded('docs/readme.md')).toBe(false);
    });

    test('malformed lines in .okignore are silently skipped (gitignore parity)', () => {
      writeFileSync(join(projectDir, '.okignore'), '   \n# valid comment\nvalid.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('valid.md')).toBe(true);
      expect(filter.isExcluded('other.md')).toBe(false);
    });
  });

  describe('nested ignore depth semantics', () => {
    test('non-anchored nested pattern matches at any depth below its directory', () => {
      mkdirSync(join(projectDir, 'agents', 'agents-api', '.blob-storage'), { recursive: true });
      writeFileSync(join(projectDir, 'agents', '.gitignore'), '.blob-storage/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('agents/agents-api/.blob-storage/doc.md')).toBe(true);
      expect(filter.isDirExcluded('agents/agents-api/.blob-storage')).toBe(true);
      expect(filter.isDirExcluded('agents/.blob-storage')).toBe(true);
      expect(filter.isDirExcluded('other/.blob-storage')).toBe(false);
    });

    test('async factory: non-anchored nested pattern matches at any depth', async () => {
      mkdirSync(join(projectDir, 'agents', 'agents-api', '.blob-storage'), { recursive: true });
      writeFileSync(join(projectDir, 'agents', '.gitignore'), '.blob-storage/\n');

      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('agents/agents-api/.blob-storage/doc.md')).toBe(true);
      expect(filter.isDirExcluded('agents/agents-api/.blob-storage')).toBe(true);
    });

    test('anchored nested pattern stays scoped to its own level (no over-match)', () => {
      mkdirSync(join(projectDir, 'pkg', 'src', 'generated'), { recursive: true });
      writeFileSync(join(projectDir, 'pkg', '.gitignore'), 'src/generated/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('pkg/src/generated/api.md')).toBe(true);
      expect(filter.isExcluded('pkg/nested/src/generated/api.md')).toBe(false);
    });

    test('non-anchored nested negation un-ignores at any depth', () => {
      mkdirSync(join(projectDir, 'logs', 'sub'), { recursive: true });
      writeFileSync(join(projectDir, 'logs', '.gitignore'), '*.md\n!keep.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('logs/debug.md')).toBe(true);
      expect(filter.isExcluded('logs/sub/keep.md')).toBe(false);
    });
  });

  describe('non-git graceful degradation', () => {
    test('works with no .gitignore and no .okignore', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('readme.md')).toBe(false);
      expect(filter.isExcluded('docs/guide.md')).toBe(false);
    });
  });

  describe('git-extras ignore sources', () => {
    function initGitRepo(dir: string): void {
      execFileSync('git', ['init', '-q'], { cwd: dir });
    }

    test('excludes paths matched by .git/info/exclude (per-clone, untracked)', () => {
      initGitRepo(projectDir);
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.scratch/worktrees/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('.scratch/worktrees')).toBe(true);
      expect(filter.isExcluded('.scratch/worktrees/feature-x/note.md')).toBe(true);
      expect(filter.isExcluded('.scratch/skills/foo.md')).toBe(false);
    });

    test('unions .git/info/exclude with project .gitignore', () => {
      initGitRepo(projectDir);
      writeFileSync(join(projectDir, '.gitignore'), 'drafts/\n');
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.scratch/worktrees/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('drafts/wip.md')).toBe(true);
      expect(filter.isExcluded('.scratch/worktrees/fx/n.md')).toBe(true);
      expect(filter.isExcluded('docs/guide.md')).toBe(false);
    });

    test('honors core.excludesfile path via git config', async () => {
      initGitRepo(projectDir);
      const globalIgnore = await mkdtemp(join(tmpdir(), 'cf-global-'));
      try {
        const ignorePath = join(globalIgnore, 'my-global-ignore');
        writeFileSync(ignorePath, '.scratch/\n');
        execFileSync('git', ['config', '--local', 'core.excludesfile', ignorePath], {
          cwd: projectDir,
        });

        const filter = createContentFilter({ projectDir, contentDir: projectDir });

        expect(filter.isExcluded('.scratch/temp.md')).toBe(true);
        expect(filter.isExcluded('docs/guide.md')).toBe(false);
      } finally {
        await rm(globalIgnore, { recursive: true, force: true });
      }
    });

    test('falls back to $XDG_CONFIG_HOME/git/ignore when core.excludesfile unset', async () => {
      initGitRepo(projectDir);
      const xdgRoot = await mkdtemp(join(tmpdir(), 'cf-xdg-'));
      try {
        mkdirSync(join(xdgRoot, 'git'), { recursive: true });
        writeFileSync(join(xdgRoot, 'git', 'ignore'), '.xdg-scratch/\n');
        const prev = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = xdgRoot;
        try {
          const filter = createContentFilter({ projectDir, contentDir: projectDir });
          expect(filter.isExcluded('.xdg-scratch/temp.md')).toBe(true);
        } finally {
          if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
          else process.env.XDG_CONFIG_HOME = prev;
        }
      } finally {
        await rm(xdgRoot, { recursive: true, force: true });
      }
    });

    test('graceful no-op on non-git dirs (no git common dir, no failure)', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'drafts/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('drafts/wip.md')).toBe(true);
      expect(filter.isExcluded('docs/guide.md')).toBe(false);
    });

    test('non-git dirs DO NOT consult global excludesfile (no git → no host-wide leak)', async () => {
      const xdgRoot = await mkdtemp(join(tmpdir(), 'cf-xdg-nongit-'));
      try {
        mkdirSync(join(xdgRoot, 'git'), { recursive: true });
        writeFileSync(join(xdgRoot, 'git', 'ignore'), '.host-wide-rule/\n');
        process.env.XDG_CONFIG_HOME = xdgRoot;

        const filter = createContentFilter({ projectDir, contentDir: projectDir });

        expect(filter.isExcluded('.host-wide-rule/note.md')).toBe(false);
      } finally {
        await rm(xdgRoot, { recursive: true, force: true });
      }
    });

    test('rebuildIgnorePatterns picks up new .git/info/exclude entries', async () => {
      initGitRepo(projectDir);
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('.scratch/worktrees/fx/n.md')).toBe(false);

      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.scratch/worktrees/\n');
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);
      expect(filter.isExcluded('.scratch/worktrees/fx/n.md')).toBe(true);
    });
  });

  describe('nested .gitignore support', () => {
    test('loads nested .gitignore files', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
      mkdirSync(join(projectDir, 'subdir'));
      writeFileSync(join(projectDir, 'subdir', '.gitignore'), 'build/\n');
      mkdirSync(join(projectDir, 'subdir', 'build'), { recursive: true });

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('subdir/build/output.md')).toBe(true);
      expect(filter.isExcluded('subdir/readme.md')).toBe(false);
    });

    test('skips already-excluded dirs during nested scan (avoids node_modules)', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
      mkdirSync(join(projectDir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(projectDir, 'node_modules', 'pkg', '.gitignore'), 'test/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('node_modules/pkg/readme.md')).toBe(true);
    });
  });

  describe('getWatcherIgnoreGlobs', () => {
    test('retains ordinary user watcher bounds while stripping managed-content blockers', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\ntmp/\n# comment\n!keep\n');
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n!important.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      const globs = filter.getWatcherIgnoreGlobs();
      expect(globs).toContain('dist/');
      expect(globs).toContain('tmp/');
      expect(globs).toContain('drafts/');
      expect(globs).not.toContain('!keep');
      expect(globs).not.toContain('!important.md');
      expect(globs).not.toContain('# comment');
    });

    test('retains ordinary user watcher bounds in the async factory', async () => {
      writeFileSync(join(projectDir, '.gitignore'), 'target/\nsecrets/\n');

      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });

      expect(filter.getWatcherIgnoreGlobs()).toEqual(
        expect.arrayContaining(['target/', 'secrets/']),
      );
    });

    test('injects structural watcher bounds when no ignore files exist', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      const globs = filter.getWatcherIgnoreGlobs();
      for (const structural of [
        '.git',
        '**/.git/**',
        'node_modules',
        '**/node_modules/**',
        '.ok/local',
        '**/.ok/local/**',
        '.ok/worktrees',
        '**/.ok/worktrees/**',
      ]) {
        expect(globs).toContain(structural);
      }
      expect(globs.some((glob) => glob === '.ok' || glob === '.ok/**')).toBe(false);
      expect(globs.some((glob) => glob.startsWith('.claude'))).toBe(false);
    });

    test('drops blanket .ok globs so the OS watcher can reach .ok/skills (skills-as-content)', () => {
      execFileSync('git', ['init', '-q'], { cwd: projectDir });
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\n.ok\nnode_modules/\n');

      const globs = createContentFilter({
        projectDir,
        contentDir: projectDir,
      }).getWatcherIgnoreGlobs();

      expect(globs).not.toContain('.ok');
      expect(globs).not.toContain('.ok/');
      expect(globs).toContain('dist/');
      expect(globs).toContain('node_modules/');
    });

    function assertCarveChildrenExcludeStripped(filter: ContentFilter) {
      const globs = filter.getWatcherIgnoreGlobs();
      expect(globs).not.toContain('**/.ok/*');
      expect(globs).not.toContain('!**/.ok/skills/');
      expect(globs).toContain('dist/');
    }

    test('drops the children-exclude the skills-sharing carve writes (sync)', () => {
      execFileSync('git', ['init', '-q'], { cwd: projectDir });
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '**/.ok/*\n!**/.ok/skills/\n');
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertCarveChildrenExcludeStripped(filter);
    });
    test('drops the children-exclude the skills-sharing carve writes (async)', async () => {
      execFileSync('git', ['init', '-q'], { cwd: projectDir });
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '**/.ok/*\n!**/.ok/skills/\n');
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\n');
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertCarveChildrenExcludeStripped(filter);
    });

    function assertInPlaceSkillWatcherAdmission(filter: ContentFilter) {
      expect(filter.isExcluded('.claude/skills/demo/SKILL.md')).toBe(false);
      const globs = filter.getWatcherIgnoreGlobs();
      expect(globs).not.toContain('.claude/*');
      for (const editorRoot of ['.claude', '.cursor', '.codex', '.agents', '.opencode', '.pi']) {
        expect(globs.some((glob) => glob === editorRoot || glob.startsWith(`${editorRoot}/`))).toBe(
          false,
        );
      }
    }

    test('strips an editor-host blocker for an admitted in-place skill (sync)', () => {
      mkdirSync(join(projectDir, '.claude', 'skills', 'demo'), { recursive: true });
      writeFileSync(join(projectDir, '.claude', 'skills', 'demo', 'SKILL.md'), '# Demo\n');
      writeFileSync(join(projectDir, '.gitignore'), '.claude/*\n!.claude/skills/\n');
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        inPlaceSkillDirs: new Set(['.claude/skills/demo']),
      });
      assertInPlaceSkillWatcherAdmission(filter);
    });

    test('strips an editor-host blocker for an admitted in-place skill (async)', async () => {
      mkdirSync(join(projectDir, '.claude', 'skills', 'demo'), { recursive: true });
      writeFileSync(join(projectDir, '.claude', 'skills', 'demo', 'SKILL.md'), '# Demo\n');
      writeFileSync(join(projectDir, '.gitignore'), '.claude/*\n!.claude/skills/\n');
      const filter = await createContentFilterAsync({
        projectDir,
        contentDir: projectDir,
        inPlaceSkillDirs: new Set(['.claude/skills/demo']),
      });
      assertInPlaceSkillWatcherAdmission(filter);
    });

    function assertShareableOkLeavesUnblocked(filter: ContentFilter) {
      const globs = filter.getWatcherIgnoreGlobs();
      for (const blocker of [
        'docs/.ok/templates/',
        'packages/app/.ok/templates/',
        '.*',
        '.ok/**/*',
        '**/.ok/**/*',
        '.ok/templates/',
        '.ok/local/../templates',
        'node_modules/../docs',
      ]) {
        expect(globs, blocker).not.toContain(blocker);
      }
      expect(globs.filter((glob) => glob === '.ok/local')).toHaveLength(1);
      expect(globs.filter((glob) => glob === '.ok/local/**')).toHaveLength(1);
      expect(globs).toContain('**/.ok/local/**');
      expect(globs).toContain('.ok/worktrees/**');
      expect(globs).toContain('**/.ok/worktrees/**');
      expect(globs).toContain('dist/');
      expect(globs).toContain('node_modules/**');
    }

    test('watcher globs never block the shareable .ok leaves; .ok/local stays pruned (sync)', () => {
      writeFileSync(
        join(projectDir, '.gitignore'),
        'dist/\nnode_modules/**\ndocs/.ok/templates/\npackages/app/.ok/templates/\n.*\n.ok\n.ok/**\n.ok/**/*\n**/.ok\n**/.ok/**\n**/.ok/**/*\n.ok/*\n**/.ok/*\n.ok/templates/\n.ok/local\n.ok/local/**\n.ok/local/../templates\nnode_modules/../docs\n',
      );
      execFileSync('git', ['init', '-q'], { cwd: projectDir });
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertShareableOkLeavesUnblocked(filter);
    });
    test('watcher globs never block the shareable .ok leaves; .ok/local stays pruned (async)', async () => {
      writeFileSync(
        join(projectDir, '.gitignore'),
        'dist/\nnode_modules/**\ndocs/.ok/templates/\npackages/app/.ok/templates/\n.*\n.ok\n.ok/**\n.ok/**/*\n**/.ok\n**/.ok/**\n**/.ok/**/*\n.ok/*\n**/.ok/*\n.ok/templates/\n.ok/local\n.ok/local/**\n.ok/local/../templates\nnode_modules/../docs\n',
      );
      execFileSync('git', ['init', '-q'], { cwd: projectDir });
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertShareableOkLeavesUnblocked(filter);
    });
  });

  describe('dot-dir scope symmetry', () => {
    test('admits user-tracked markdown in non-built-in dot dirs and rejects built-in/internal dirs', () => {
      mkdirSync(join(projectDir, '.cursor', 'skills', 'open-knowledge'), { recursive: true });
      writeFileSync(
        join(projectDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'),
        '# Skill\n',
      );
      writeFileSync(join(projectDir, '.cursor', 'skills', 'open-knowledge', 'diagram.png'), 'png');
      mkdirSync(join(projectDir, '.claude', 'skills'), { recursive: true });
      writeFileSync(join(projectDir, '.claude', 'skills', 'foo.md'), '# Claude\n');
      mkdirSync(join(projectDir, '.agents', 'skills'), { recursive: true });
      writeFileSync(join(projectDir, '.agents', 'skills', 'foo.md'), '# Agents\n');
      mkdirSync(join(projectDir, '.codex', 'skills'), { recursive: true });
      writeFileSync(join(projectDir, '.codex', 'skills', 'foo.md'), '# Codex\n');
      mkdirSync(join(projectDir, '.github'), { recursive: true });
      writeFileSync(join(projectDir, '.github', 'PULL_REQUEST_TEMPLATE.md'), '# PR\n');
      mkdirSync(join(projectDir, '.vscode'), { recursive: true });
      writeFileSync(join(projectDir, '.vscode', 'notes.md'), '# Notes\n');
      mkdirSync(join(projectDir, 'packages', '.cursor', 'skills'), { recursive: true });
      writeFileSync(join(projectDir, 'packages', '.cursor', 'skills', 'SKILL.md'), '# Nested\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('.cursor/skills/SKILL.md')).toBe(true);
      expect(filter.isExcluded('.claude/skills/foo.md')).toBe(true);
      expect(filter.isExcluded('.agents/skills/foo.md')).toBe(true);
      expect(filter.isExcluded('.codex/skills/foo.md')).toBe(true);
      expect(filter.isExcluded('.opencode/skills/foo.md')).toBe(true);
      expect(filter.isExcluded('packages/.cursor/skills/SKILL.md')).toBe(true);
      expect(filter.isExcluded('.cursor/skills/open-knowledge/diagram.png')).toBe(true);

      expect(filter.isExcluded('.github/PULL_REQUEST_TEMPLATE.md')).toBe(false);
      expect(filter.isExcluded('.vscode/notes.md')).toBe(false);

      expect(filter.isExcluded('.git/config')).toBe(true);
      expect(filter.isExcluded('.ok/config.yml')).toBe(true);
      expect(filter.isExcluded('node_modules/foo/README.md')).toBe(true);
      expect(filter.isExcluded('.next/build.md')).toBe(true);
      expect(filter.isExcluded('apps/web/.next/foo.md')).toBe(true);

      expect(filter.isExcluded('.cursor/mcp.json')).toBe(true);
      expect(filter.isExcluded('.github/workflows/ci.yml')).toBe(true);
      expect(filter.isExcluded('.cursor/rules/some-rule.mdc')).toBe(true);
      expect(filter.isExcluded('.claude/settings.local.json')).toBe(true);

      expect(filter.isDirExcluded('.cursor')).toBe(true);
      expect(filter.isDirExcluded('.git')).toBe(true);
      expect(filter.isDirExcluded('.ok')).toBe(false);
      expect(filter.isDirExcluded('.ok/local')).toBe(true);
    });
  });

  describe('in-place skill admission (allow-list)', () => {
    test('a gitignored bundle is NOT admitted, even on the allow-list', () => {
      writeFileSync(join(projectDir, '.gitignore'), '.claude/skills/open-knowledge/\n');
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        inPlaceSkillDirs: new Set([
          '.claude/skills/open-knowledge',
          '.agents/skills/open-knowledge',
        ]),
      });

      expect(filter.isExcluded('.claude/skills/open-knowledge/SKILL.md')).toBe(true);
      expect(filter.isPathIgnored('.claude/skills/open-knowledge/SKILL.md')).toBe(true);
      expect(filter.isExcluded('.agents/skills/open-knowledge/SKILL.md')).toBe(false);
      expect(filter.isPathIgnored('.agents/skills/open-knowledge/SKILL.md')).toBe(false);
    });

    test('admits ONLY the registry canonical bundle dirs out of the editor host dirs', () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        inPlaceSkillDirs: new Set(['.claude/skills/foo', '.codex/skills/bar']),
      });

      expect(filter.isExcluded('.claude/skills/foo/SKILL.md')).toBe(false);
      expect(filter.isExcluded('.claude/skills/foo/references/patterns.md')).toBe(false);
      expect(filter.isExcluded('.claude/skills/foo/diagram.png')).toBe(false);
      expect(filter.isExcluded('.codex/skills/bar/SKILL.md')).toBe(false);
      expect(filter.isDirExcluded('.claude')).toBe(false);
      expect(filter.isDirExcluded('.claude/skills')).toBe(false);
      expect(filter.isDirExcluded('.claude/skills/foo')).toBe(false);
      expect(filter.isPathIgnored('.claude/skills/foo/diagram.png')).toBe(false);

      expect(filter.isExcluded('.claude/skills/other/SKILL.md')).toBe(true);
      expect(filter.isDirExcluded('.claude/skills/other')).toBe(true);
      expect(filter.isExcluded('.claude/plugins/p/manifest.md')).toBe(true);
      expect(filter.isDirExcluded('.claude/plugins')).toBe(true);
      expect(filter.isExcluded('.claude/settings.local.json')).toBe(true);
      expect(filter.isExcluded('.cursor/mcp.json')).toBe(true);
      expect(filter.isExcluded('.claude/skills/foo/.env')).toBe(true);
      expect(filter.isDirExcluded('.claude/skills/foo/.ssh')).toBe(true);
    });

    test('empty/omitted allow-list = feature off (editor dirs stay fully skipped)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('.claude/skills/foo/SKILL.md')).toBe(true);
      expect(filter.isDirExcluded('.claude')).toBe(true);
    });
  });

  describe('isDirExcluded', () => {
    test('excludes directories matching gitignore directory patterns (trailing slash)', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\ndist/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('node_modules')).toBe(true);
      expect(filter.isDirExcluded('dist')).toBe(true);
      expect(filter.isDirExcluded('src')).toBe(false);
      expect(filter.isDirExcluded('docs')).toBe(false);
    });

    test('excludes directories matching .okignore patterns', () => {
      writeFileSync(join(projectDir, '.okignore'), 'archive/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('archive')).toBe(true);
      expect(filter.isDirExcluded('docs')).toBe(false);
    });

    test('excludes built-in skip dirs even without an ignore-file entry', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('node_modules')).toBe(true);
      expect(filter.isDirExcluded('node_modules/some-pkg')).toBe(true);
      expect(filter.isDirExcluded('.venv')).toBe(true);
      expect(filter.isDirExcluded('vendor')).toBe(true);
      expect(filter.isDirExcluded('dist')).toBe(true);
      expect(filter.isDirExcluded('build')).toBe(true);
      expect(filter.isDirExcluded('.next')).toBe(true);
      expect(filter.isDirExcluded('.turbo')).toBe(true);
      expect(filter.isDirExcluded('coverage')).toBe(true);
      expect(filter.isDirExcluded('.git')).toBe(true);
      expect(filter.isDirExcluded('.ok')).toBe(false);
      expect(filter.isDirExcluded('.ok/local')).toBe(true);
      expect(filter.isDirExcluded('.ok/local/cache')).toBe(true);
      expect(filter.isDirExcluded('docs')).toBe(false);
      expect(filter.isDirExcluded('src')).toBe(false);
    });

    test('excludes BUILTIN_SKIP_DIRS at any path depth, not just top segment (FR-CF1)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('meetings/.ok')).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok/templates')).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok/local')).toBe(true);
      expect(filter.isDirExcluded('a/b/c/.ok/d')).toBe(true);

      expect(filter.isDirExcluded('packages/foo/node_modules')).toBe(true);
      expect(filter.isDirExcluded('packages/foo/node_modules/bar')).toBe(true);

      expect(filter.isDirExcluded('apps/web/dist')).toBe(true);
      expect(filter.isDirExcluded('apps/web/.next/cache')).toBe(true);

      expect(filter.isDirExcluded('meetings/prep-notes')).toBe(false);
      expect(filter.isDirExcluded('a/b/c')).toBe(false);
    });

    test('does not descend into node_modules during populateDirCount even with a symlink inside', () => {
      const nmDir = join(projectDir, 'node_modules');
      mkdirSync(nmDir);
      symlinkSync(join(nmDir, 'nonexistent-target'), join(nmDir, 'broken-link'));
      writeFileSync(join(nmDir, 'README.md'), '# Pkg\n');
      writeFileSync(join(projectDir, 'docs.md'), '# Docs\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('node_modules/logo.png')).toBe(true);
    });

    test('admits .ok only down the skills path; non-skill .ok files stay excluded', () => {
      mkdirSync(join(projectDir, '.ok'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'AGENTS.md'), '# Agents\n');
      writeFileSync(join(projectDir, 'docs.md'), '# Docs\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('.ok')).toBe(false);
      expect(filter.isDirExcluded('.ok/local')).toBe(true);
      expect(filter.isExcluded('.ok/logo.png')).toBe(true);
      expect(filter.isExcluded('.ok/AGENTS.md')).toBe(true);
    });

    test('isExcluded rejects supported docs born inside BUILTIN_SKIP_DIRS except the templates carve-out', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('.ok/templates/daily.md')).toBe(false);
      expect(filter.isExcluded('meetings/.ok/templates/standup.md')).toBe(false);
      expect(filter.isExcluded('meetings/.ok/frontmatter.yml.md')).toBe(true);
      expect(filter.isExcluded('node_modules/some-pkg/README.md')).toBe(true);
      expect(filter.isExcluded('apps/web/dist/index.md')).toBe(true);

      expect(filter.isExcluded('meetings/prep-notes.md')).toBe(false);
      expect(filter.isExcluded('docs/intro.md')).toBe(false);
    });
  });

  describe('templates-as-content admission', () => {
    function assertTemplateAdmission(filter: ContentFilter) {
      expect(filter.isExcluded('.ok/templates/daily.md')).toBe(false);
      expect(filter.isExcluded('meetings/.ok/templates/standup.md')).toBe(false);
      expect(filter.isExcluded('a/b/.ok/templates/note.md')).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok')).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok/templates')).toBe(false);
      expect(filter.isExcluded('.ok/templates/daily.mdx')).toBe(true);
      expect(filter.isDirExcluded('.ok/templates/sub')).toBe(true);
      expect(filter.isExcluded('.ok/templates/sub/x.md')).toBe(true);
      expect(filter.isPathIgnored('.ok/templates/daily.md')).toBe(false);
    }

    test('sync factory (createContentFilter)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertTemplateAdmission(filter);
    });

    test('async factory (createContentFilterAsync) mirrors admission', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertTemplateAdmission(filter);
    });
  });

  describe('templates-as-content carve-out matrix (FR1)', () => {
    function assertSecretFloorWins(filter: ContentFilter) {
      for (const secret of [
        '.ok/templates/server.key',
        '.ok/templates/server.pem',
        'meetings/.ok/templates/id_rsa',
      ]) {
        expect(filter.isExcluded(secret), secret).toBe(true);
        expect(filter.isPathIgnored(secret), secret).toBe(true);
      }
      expect(filter.isDirExcluded('.ok/templates/.ssh')).toBe(true);
      expect(filter.isExcluded('.ok/templates/daily.md')).toBe(false);
    }

    test('secret floor wins over the carve-out (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertSecretFloorWins(filter);
    });
    test('secret floor wins over the carve-out (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertSecretFloorWins(filter);
    });

    function assertCarveOutIsNarrow(filter: ContentFilter) {
      expect(filter.isExcluded('.ok/templates/daily.md')).toBe(false);
      expect(filter.isExcluded('meetings/.ok/templates/standup.md')).toBe(false);
      expect(filter.isExcluded('.ok/config.yml')).toBe(true);
      expect(filter.isExcluded('.ok/AGENTS.md')).toBe(true);
      expect(filter.isExcluded('meetings/.ok/frontmatter.yml.md')).toBe(true);
      expect(filter.isExcluded('.ok/local/cache/notes.md')).toBe(true);
      expect(filter.isDirExcluded('.ok/local')).toBe(true);
      expect(filter.isDirExcluded('.ok/worktrees')).toBe(true);
      expect(filter.isDirExcluded('meetings/.ok/local')).toBe(true);
    }

    test('carve-out does not over-admit other .ok children (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertCarveOutIsNarrow(filter);
    });
    test('carve-out does not over-admit other .ok children (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertCarveOutIsNarrow(filter);
    });

    function assertFolderIndexDescendable(filter: ContentFilter) {
      expect(filter.isDirExcluded('.ok')).toBe(false);
      expect(filter.isDirExcluded('.ok/templates')).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok')).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok/templates')).toBe(false);
      expect(filter.isDirExcluded('a/b/.ok')).toBe(false);
      expect(filter.isDirExcluded('a/b/.ok/templates')).toBe(false);
      expect(filter.isDirExcluded('.ok/templates/sub')).toBe(true);
      expect(filter.isDirExcluded('meetings/.ok/templates/sub')).toBe(true);
    }

    test('folder-index keeps nested .ok/templates descendable (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertFolderIndexDescendable(filter);
    });
    test('folder-index keeps nested .ok/templates descendable (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertFolderIndexDescendable(filter);
    });

    async function assertBootWalkAdmits(makeFilter: () => ContentFilter | Promise<ContentFilter>) {
      mkdirSync(join(projectDir, 'meetings', '.ok', 'templates'), { recursive: true });
      writeFileSync(join(projectDir, 'meetings', '.ok', 'templates', 'standup.md'), '# Standup\n');
      const filter = await makeFilter();
      expect(filter.isDirExcluded('meetings')).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok')).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok/templates')).toBe(false);
      expect(filter.isExcluded('meetings/.ok/templates/standup.md')).toBe(false);
    }

    test('pre-existing template on disk is admitted by the walk (sync)', async () => {
      await assertBootWalkAdmits(() => createContentFilter({ projectDir, contentDir: projectDir }));
    });
    test('pre-existing template on disk is admitted by the walk (async)', async () => {
      await assertBootWalkAdmits(() =>
        createContentFilterAsync({ projectDir, contentDir: projectDir }),
      );
    });

    function assertSingleFileScope(filter: ContentFilter) {
      expect(filter.isExcluded('notes.md')).toBe(false);
      expect(filter.isExcluded('.ok/templates/daily.md')).toBe(true);
      expect(filter.isExcluded('meetings/.ok/templates/standup.md')).toBe(true);
      expect(filter.isPathIgnored('.ok/templates/daily.md')).toBe(false);
    }

    test('single-file scope excludes templates (sync)', () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });
      assertSingleFileScope(filter);
    });
    test('single-file scope excludes templates (async)', async () => {
      const filter = await createContentFilterAsync({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });
      assertSingleFileScope(filter);
    });

    function assertGlobStripSet(filter: ContentFilter) {
      const globs = filter.getWatcherIgnoreGlobs();
      for (const blanket of ['.ok', '.ok/**', '**/.ok', '**/.ok/**']) {
        expect(globs, blanket).not.toContain(blanket);
      }
      expect(globs).toContain('.ok/local');
      expect(globs).toContain('dist/');
      expect(globs).toContain('node_modules/');
    }

    test('watcher glob strip drops blanket .ok, keeps the rest (sync)', () => {
      writeFileSync(
        join(projectDir, '.gitignore'),
        'dist/\nnode_modules/\n.ok\n.ok/**\n**/.ok\n**/.ok/**\n.ok/local\n',
      );
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertGlobStripSet(filter);
    });
    test('watcher glob strip drops blanket .ok, keeps the rest (async)', async () => {
      writeFileSync(
        join(projectDir, '.gitignore'),
        'dist/\nnode_modules/\n.ok\n.ok/**\n**/.ok\n**/.ok/**\n.ok/local\n',
      );
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertGlobStripSet(filter);
    });
  });

  describe('templates-as-content carve-out stays below the skip-dir floor', () => {
    function assertSkipDirAncestorExcluded(filter: ContentFilter) {
      for (const vendored of [
        'node_modules/pkg/.ok/templates/x.md',
        'dist/.ok/templates/x.md',
        'vendor/lib/.ok/templates/note.md',
      ]) {
        expect(filter.isExcluded(vendored), vendored).toBe(true);
        expect(filter.isPathIgnored(vendored), vendored).toBe(true);
      }
      expect(filter.isExcluded('docs/.ok/templates/x.md')).toBe(false);
      expect(filter.isExcluded('a/b/c/.ok/templates/x.md')).toBe(false);
      expect(filter.isPathIgnored('docs/.ok/templates/x.md')).toBe(false);
      expect(filter.isDirExcluded('node_modules/pkg/.ok')).toBe(true);
      expect(filter.isDirExcluded('dist/.ok/templates')).toBe(true);
    }

    test('skip-dir ancestor excluded from admission and serve path (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertSkipDirAncestorExcluded(filter);
    });
    test('skip-dir ancestor excluded from admission and serve path (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertSkipDirAncestorExcluded(filter);
    });
  });

  describe('shareable .ok artifact sync scope (allow-list)', () => {
    const SYNC = { syncScope: { pathBase: 'project' } } as const;

    function assertSyncScopeAdmission(filter: ContentFilter) {
      expect(filter.isExcluded('.ok/config.yml', SYNC)).toBe(false);
      expect(filter.isExcluded('.ok/.gitignore', SYNC)).toBe(false);
      expect(filter.isExcluded('.ok/schemas/lint.json', SYNC)).toBe(false);
      expect(filter.isExcluded('.ok/schemas/LINT.JSON', SYNC)).toBe(false);
      expect(filter.isExcluded('.ok/templates/daily.md', SYNC)).toBe(false);
      expect(filter.isExcluded('meetings/.ok/templates/standup.md', SYNC)).toBe(false);
      expect(filter.isExcluded('meetings/.ok/frontmatter.yml', SYNC)).toBe(false);
      expect(filter.isExcluded('a/b/c/.ok/frontmatter.yml', SYNC)).toBe(false);
      expect(filter.isExcluded('.ok/frontmatter.yml', SYNC)).toBe(false);
    }

    test('sync scope admits exactly the shareable artifact shapes (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertSyncScopeAdmission(filter);
    });
    test('sync scope admits exactly the shareable artifact shapes (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertSyncScopeAdmission(filter);
    });

    function assertSubfolderPathCoordinates(filter: ContentFilter) {
      const contentScope = { syncScope: { pathBase: 'content' } } as const;
      const projectScope = { syncScope: { pathBase: 'project' } } as const;

      expect(filter.isExcluded('.ok/config.yml', contentScope)).toBe(true);
      expect(filter.isExcluded('.ok/.gitignore', contentScope)).toBe(true);
      expect(filter.isExcluded('.ok/schemas/lint.json', contentScope)).toBe(true);
      expect(filter.isDirExcluded('.ok/schemas', contentScope)).toBe(true);

      expect(filter.isExcluded('.ok/config.yml', projectScope)).toBe(false);
      expect(filter.isExcluded('.ok/.gitignore', projectScope)).toBe(false);
      expect(filter.isExcluded('.ok/schemas/lint.json', projectScope)).toBe(false);
      expect(filter.isDirExcluded('.ok/schemas', projectScope)).toBe(false);

      expect(filter.isExcluded('.ok/templates/daily.md', contentScope)).toBe(false);
      expect(filter.isExcluded('.ok/frontmatter.yml', contentScope)).toBe(true);
      expect(filter.isExcluded('note.md', contentScope)).toBe(true);
    }

    test('subfolder content and project walks use distinct path coordinates (sync)', () => {
      const contentDir = join(projectDir, 'content');
      mkdirSync(contentDir);
      writeFileSync(
        join(projectDir, '.gitignore'),
        '/content/note.md\n/content/.ok/frontmatter.yml\n',
      );
      const filter = createContentFilter({ projectDir, contentDir });
      assertSubfolderPathCoordinates(filter);
    });

    test('subfolder content and project walks use distinct path coordinates (async)', async () => {
      const contentDir = join(projectDir, 'content');
      mkdirSync(contentDir);
      writeFileSync(
        join(projectDir, '.gitignore'),
        '/content/note.md\n/content/.ok/frontmatter.yml\n',
      );
      const filter = await createContentFilterAsync({ projectDir, contentDir });
      assertSubfolderPathCoordinates(filter);
    });

    function assertSyncScopeIsNarrow(filter: ContentFilter) {
      for (const path of [
        '.ok/local/server.lock',
        '.ok/local/cache/embeddings.json',
        '.ok/worktrees/wt1/notes.md',
        '.ok/principal.json',
        '.ok/state.json',
        '.ok/server.lock',
        '.ok/ui.lock',
        '.ok/sync-state.json',
        '.ok/last-spawn-error.log',
        '.ok/AGENTS.md',
        '.ok/schemas/nested/deep.json',
        '.ok/schemas/readme.md',
        'docs/.ok/config.yml',
        'docs/.ok/.gitignore',
        'docs/.ok/schemas/lint.json',
      ]) {
        expect(filter.isExcluded(path, SYNC), path).toBe(true);
      }
    }

    test('sync scope never becomes a blanket .ok admission (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertSyncScopeIsNarrow(filter);
    });
    test('sync scope never becomes a blanket .ok admission (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertSyncScopeIsNarrow(filter);
    });

    function assertSecretFloorPrecedesSyncScope(filter: ContentFilter) {
      for (const secret of ['.ok/schemas/foo.key', '.ok/schemas/service.pem', '.ok/schemas/.env']) {
        expect(filter.isExcluded(secret, SYNC), secret).toBe(true);
      }
      expect(filter.isDirExcluded('.ok/.ssh', SYNC)).toBe(true);
      expect(filter.isExcluded('.ok/schemas/foo.json', SYNC)).toBe(false);
    }

    test('secret floor wins over the sync scope (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertSecretFloorPrecedesSyncScope(filter);
    });
    test('secret floor wins over the sync scope (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertSecretFloorPrecedesSyncScope(filter);
    });

    function assertSyncScopeDirAncestors(filter: ContentFilter) {
      expect(filter.isDirExcluded('.ok', SYNC)).toBe(false);
      expect(filter.isDirExcluded('.ok/schemas', SYNC)).toBe(false);
      expect(filter.isDirExcluded('.ok/templates', SYNC)).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok', SYNC)).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok/templates', SYNC)).toBe(false);
      expect(filter.isDirExcluded('.ok/schemas/sub', SYNC)).toBe(true);
      expect(filter.isDirExcluded('.ok/local', SYNC)).toBe(true);
      expect(filter.isDirExcluded('.ok/worktrees', SYNC)).toBe(true);
      expect(filter.isDirExcluded('node_modules/pkg/.ok', SYNC)).toBe(true);
      expect(filter.isDirExcluded('docs/.ok/schemas', SYNC)).toBe(true);
    }

    test('sync scope keeps the schemas dir descendable, bounded (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertSyncScopeDirAncestors(filter);
    });
    test('sync scope keeps the schemas dir descendable, bounded (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertSyncScopeDirAncestors(filter);
    });

    function assertSyncScopeSkipDirBound(filter: ContentFilter) {
      for (const vendored of [
        'node_modules/pkg/.ok/frontmatter.yml',
        'dist/.ok/frontmatter.yml',
        '.ok/worktrees/wt1/docs/.ok/frontmatter.yml',
        '.ok/worktrees/wt1/.ok/config.yml',
        '.OK/local/cache/.ok/frontmatter.yml',
        '.OK/worktrees/wt1/docs/.ok/frontmatter.yml',
        'node_modules/pkg/.ok/templates/x.md',
      ]) {
        expect(filter.isExcluded(vendored, SYNC), vendored).toBe(true);
      }
      expect(filter.isExcluded('a/b/c/.ok/frontmatter.yml', SYNC)).toBe(false);
    }

    test('skip-dir ancestors stay excluded from sync scope (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertSyncScopeSkipDirBound(filter);
    });
    test('skip-dir ancestors stay excluded from sync scope (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertSyncScopeSkipDirBound(filter);
    });

    function assertGitignoredArtifactsRefused(filter: ContentFilter) {
      expect(filter.isExcluded('.ok/config.yml', SYNC)).toBe(true);
      expect(filter.isExcluded('.ok/.gitignore', SYNC)).toBe(true);
      expect(filter.isExcluded('.ok/schemas/lint.json', SYNC)).toBe(true);
      expect(filter.isExcluded('.ok/frontmatter.yml', SYNC)).toBe(true);
    }

    test('gitignored artifacts are NOT admitted, even with the scope (sync)', () => {
      writeFileSync(join(projectDir, '.gitignore'), '.ok/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertGitignoredArtifactsRefused(filter);
    });
    test('gitignored artifacts are NOT admitted, even with the scope (async)', async () => {
      writeFileSync(join(projectDir, '.gitignore'), '.ok/\n');
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertGitignoredArtifactsRefused(filter);
    });

    test('a narrower gitignore refuses only its own subtree (sync)', () => {
      writeFileSync(join(projectDir, '.gitignore'), '.ok/schemas/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('.ok/schemas/lint.json', SYNC)).toBe(true);
      expect(filter.isExcluded('.ok/config.yml', SYNC)).toBe(false);
    });
    test('a narrower gitignore refuses only its own subtree (async)', async () => {
      writeFileSync(join(projectDir, '.gitignore'), '.ok/schemas/\n');
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('.ok/schemas/lint.json', SYNC)).toBe(true);
      expect(filter.isExcluded('.ok/config.yml', SYNC)).toBe(false);
    });

    function assertNoScopeBehaviorUnchanged(filter: ContentFilter) {
      expect(filter.isExcluded('.ok/config.yml')).toBe(true);
      expect(filter.isExcluded('.ok/.gitignore')).toBe(true);
      expect(filter.isExcluded('.ok/schemas/lint.json')).toBe(true);
      expect(filter.isExcluded('meetings/.ok/frontmatter.yml')).toBe(true);
      expect(filter.isExcluded('.ok/frontmatter.yml')).toBe(true);
      expect(filter.isDirExcluded('.ok/schemas')).toBe(true);
      expect(filter.isExcluded('.ok/templates/daily.md')).toBe(false);
      expect(filter.isExcluded('meetings/.ok/templates/standup.md')).toBe(false);
    }

    test('without the scope the index/sidebar view is unchanged (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertNoScopeBehaviorUnchanged(filter);
    });
    test('without the scope the index/sidebar view is unchanged (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertNoScopeBehaviorUnchanged(filter);
    });

    function assertServeFloorHolds(filter: ContentFilter) {
      expect(filter.isPathIgnored('.ok/config.yml')).toBe(true);
      expect(filter.isPathIgnored('.ok/.gitignore')).toBe(true);
      expect(filter.isPathIgnored('.ok/schemas/lint.json')).toBe(true);
      expect(filter.isPathIgnored('meetings/.ok/frontmatter.yml')).toBe(true);
    }

    test('the asset-serve gate ignores the scope (sync)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertServeFloorHolds(filter);
    });
    test('the asset-serve gate ignores the scope (async)', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertServeFloorHolds(filter);
    });

    function assertSingleFileScopeHolds(filter: ContentFilter) {
      expect(filter.isExcluded('notes.md', SYNC)).toBe(false);
      expect(filter.isExcluded('.ok/config.yml', SYNC)).toBe(true);
      expect(filter.isExcluded('.ok/schemas/lint.json', SYNC)).toBe(true);
    }

    test('single-file scope excludes shareable artifacts (sync)', () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });
      assertSingleFileScopeHolds(filter);
    });
    test('single-file scope excludes shareable artifacts (async)', async () => {
      const filter = await createContentFilterAsync({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });
      assertSingleFileScopeHolds(filter);
    });

    test('sync scope and bypass remain separate runtime modes', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('.ok/config.yml', SYNC)).toBe(false);
      expect(filter.isExcluded('.ok/config.yml', { bypassFilters: true })).toBe(true);
      expect(filter.isPathIgnored('.ok/config.yml', { bypassFilters: true })).toBe(true);
    });
  });

  describe('always-skip floor survives bypassFilters (Show All Files OOM guard)', () => {
    const BYPASS = { bypassFilters: true, respectOkignore: true } as const;

    function assertFloor(filter: ContentFilter) {
      expect(filter.isDirExcluded('.git', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('node_modules', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('node_modules/some-pkg', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.ok', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.ok/local', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.open-knowledge', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.openknowledge', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('packages/foo/node_modules', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('a/b/.git/c', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('meetings/.ok/templates', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('a/b/.open-knowledge/c', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('a/b/.openknowledge', BYPASS)).toBe(true);

      expect(filter.isExcluded('.git/objects/x.md', BYPASS)).toBe(true);
      expect(filter.isExcluded('node_modules/pkg/README.md', BYPASS)).toBe(true);
      expect(filter.isExcluded('.ok/templates/daily.md', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.git/config', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('node_modules/pkg/index.js', BYPASS)).toBe(true);

      expect(filter.isExcluded('.DS_Store', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/.DS_Store', BYPASS)).toBe(true);
      expect(filter.isExcluded('a/b/c/.DS_Store', BYPASS)).toBe(true);
      expect(filter.isExcluded('.localized', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/.localized', BYPASS)).toBe(true);
      expect(filter.isExcluded('Thumbs.db', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/Thumbs.db', BYPASS)).toBe(true);
      expect(filter.isExcluded('desktop.ini', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/Desktop.ini', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/dEsKtOp.InI', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/THUMBS.DB', BYPASS)).toBe(true);
      expect(filter.isExcluded('.directory', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/.directory', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.DS_Store', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('notes/.DS_Store', BYPASS)).toBe(true);
      expect(filter.isExcluded('archive.DS_Store', BYPASS)).toBe(false);
      expect(filter.isExcluded('notes/my.DS_Store.md', BYPASS)).toBe(false);
      expect(filter.isExcluded('Thumbs.db.md', BYPASS)).toBe(false);
      expect(filter.isExcluded('project.directory', BYPASS)).toBe(false);

      expect(filter.isExcluded('.env', BYPASS)).toBe(true);
      expect(filter.isExcluded('.env.local', BYPASS)).toBe(true);
      expect(filter.isExcluded('.env.production', BYPASS)).toBe(true);
      expect(filter.isExcluded('packages/server/.env', BYPASS)).toBe(true);
      expect(filter.isExcluded('aws-prod-root-key.pem', BYPASS)).toBe(true);
      expect(filter.isExcluded('SERVER.PEM', BYPASS)).toBe(true);
      expect(filter.isExcluded('secrets/cert.key', BYPASS)).toBe(true);
      expect(filter.isExcluded('artifacts/cert.p12', BYPASS)).toBe(true);
      expect(filter.isExcluded('id_rsa', BYPASS)).toBe(true);
      expect(filter.isExcluded('id_rsa.pub', BYPASS)).toBe(true);
      expect(filter.isExcluded('.aws/credentials', BYPASS)).toBe(true);
      expect(filter.isExcluded('credentials', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.env', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('packages/.env.local', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('aws-prod-root-key.pem', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('id_rsa', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.ssh', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.aws', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.gnupg', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.kube', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.docker', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('home/user/.ssh', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('home/user/.kube', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('home/user/.docker', BYPASS)).toBe(true);
      expect(filter.isExcluded('.ssh/id_ed25519', BYPASS)).toBe(true);
      expect(filter.isExcluded('.kube/config', BYPASS)).toBe(true);
      expect(filter.isExcluded('.docker/config.json', BYPASS)).toBe(true);
      expect(filter.isExcluded('home/user/.aws/credentials', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.ssh/known_hosts', BYPASS)).toBe(true);
      expect(filter.isExcluded('id_ed25519', BYPASS)).toBe(true);
      expect(filter.isExcluded('id_ecdsa', BYPASS)).toBe(true);
      expect(filter.isExcluded('id_dsa', BYPASS)).toBe(true);
      expect(filter.isExcluded('id_ed25519.pub', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('id_ed25519', BYPASS)).toBe(true);
      expect(filter.isExcluded('.netrc', BYPASS)).toBe(true);
      expect(filter.isExcluded('.npmrc', BYPASS)).toBe(true);
      expect(filter.isExcluded('.pgpass', BYPASS)).toBe(true);
      expect(filter.isExcluded('.git-credentials', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/.netrc', BYPASS)).toBe(true);
      expect(filter.isExcluded('packages/.npmrc', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.netrc', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.git-credentials', BYPASS)).toBe(true);
      expect(filter.isExcluded('certs/server.pfx', BYPASS)).toBe(true);
      expect(filter.isExcluded('certs/SERVER.PFX', BYPASS)).toBe(true);
      expect(filter.isExcluded('app/release.keystore', BYPASS)).toBe(true);
      expect(filter.isExcluded('release.jks', BYPASS)).toBe(true);
      expect(filter.isExcluded('windows-id.ppk', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('release.jks', BYPASS)).toBe(true);
      expect(filter.isExcluded('docs/.environment.md', BYPASS)).toBe(false);
      expect(filter.isExcluded('docs/keymap.md', BYPASS)).toBe(false);
      expect(filter.isExcluded('packages/foo/keynote.md', BYPASS)).toBe(false);
      expect(filter.isExcluded('docs/.npmrc.example', BYPASS)).toBe(false);
      expect(filter.isExcluded('docs/mynetrc.md', BYPASS)).toBe(false);

      expect(filter.isExcluded('.ENV', BYPASS)).toBe(true);
      expect(filter.isExcluded('packages/server/.Env.Production', BYPASS)).toBe(true);
      expect(filter.isExcluded('ID_RSA', BYPASS)).toBe(true);
      expect(filter.isExcluded('ID_ED25519', BYPASS)).toBe(true);
      expect(filter.isExcluded('CREDENTIALS', BYPASS)).toBe(true);
      expect(filter.isExcluded('.GIT-CREDENTIALS', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.ENV', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.SSH', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('home/user/.AWS', BYPASS)).toBe(true);
      expect(filter.isExcluded('.SSH/known_hosts', BYPASS)).toBe(true);
      expect(filter.isExcluded('docs/.Environment.md', BYPASS)).toBe(false);
      expect(filter.isExcluded('docs/KEYMAP.md', BYPASS)).toBe(false);

      expect(filter.isExcluded('.ok/skills/foo/server.key')).toBe(true);
      expect(filter.isExcluded('.ok/skills/foo/id_rsa')).toBe(true);
      expect(filter.isExcluded('.ok/skills/foo/.env')).toBe(true);
      expect(filter.isPathIgnored('.ok/skills/foo/server.key')).toBe(true);
      expect(filter.isPathIgnored('.ok/skills/foo/id_rsa')).toBe(true);
      expect(filter.isPathIgnored('.ok/skills/foo/.env')).toBe(true);
      expect(filter.isDirExcluded('.ok/skills/foo/.ssh')).toBe(true);
      expect(filter.isExcluded('.ok/skills/foo/SKILL.md')).toBe(false);
      expect(filter.isExcluded('.ok/skills/foo/diagram.png')).toBe(false);

      expect(filter.isDirExcluded('dist', BYPASS)).toBe(false);
      expect(filter.isDirExcluded('build', BYPASS)).toBe(false);
      expect(filter.isDirExcluded('coverage', BYPASS)).toBe(false);
      expect(filter.isDirExcluded('.venv', BYPASS)).toBe(false);
      expect(filter.isExcluded('dist/bundle.js', BYPASS)).toBe(false);
      expect(filter.isExcluded('build/compiled.md', BYPASS)).toBe(false);

      expect(filter.isDirExcluded('docs', BYPASS)).toBe(false);
      expect(filter.isExcluded('docs/intro.md', BYPASS)).toBe(false);

      expect(filter.isExcluded('__system__.md', BYPASS)).toBe(true);
      expect(filter.isExcluded('__config__/project.md', BYPASS)).toBe(true);
    }

    test('sync factory (createContentFilter)', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\nbuild/\ncoverage/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertFloor(filter);
    });

    test('async factory (createContentFilterAsync) mirrors the floor', async () => {
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\nbuild/\ncoverage/\n');
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertFloor(filter);
    });
  });

  describe('showOk lifts the .ok floor for the tree-listing walk only', () => {
    const REVEAL = { bypassFilters: true, showOk: true } as const;

    function assertShowOkReveal(filter: ContentFilter) {
      expect(filter.isDirExcluded('.ok', REVEAL)).toBe(false);
      expect(filter.isDirExcluded('.ok/templates', REVEAL)).toBe(false);
      expect(filter.isDirExcluded('.ok/skills', REVEAL)).toBe(false);
      expect(filter.isDirExcluded('.ok/skills/demo', REVEAL)).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok', REVEAL)).toBe(false);
      expect(filter.isDirExcluded('meetings/.ok/templates', REVEAL)).toBe(false);

      expect(filter.isDirExcluded('.ok/worktrees', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.ok/worktrees/checkout', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.ok/local', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.ok/local/cache', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('meetings/.ok/worktrees', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('meetings/.ok/local', REVEAL)).toBe(true);

      expect(filter.isDirExcluded('.ok/Worktrees', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.ok/Local', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.OK/worktrees', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.OK/local', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.ok/LOCAL/cache', REVEAL)).toBe(true);
      expect(filter.isExcluded('.ok/Local/server.lock', REVEAL)).toBe(true);
      expect(filter.isExcluded('.OK/local/server.lock', REVEAL)).toBe(true);
      expect(filter.isExcluded('.OK/worktrees/wt/.ok/frontmatter.yml', REVEAL)).toBe(true);
      expect(filter.isExcluded('meetings/.ok/WORKTREES/checkout/README.md', REVEAL)).toBe(true);

      expect(filter.isExcluded('.ok/config.yml', REVEAL)).toBe(false);
      expect(filter.isExcluded('.ok/.gitignore', REVEAL)).toBe(false);
      expect(filter.isExcluded('.ok/templates/daily.md', REVEAL)).toBe(false);
      expect(filter.isExcluded('.ok/skills/demo/SKILL.md', REVEAL)).toBe(false);
      expect(filter.isExcluded('meetings/.ok/frontmatter.yml', REVEAL)).toBe(false);
      expect(filter.isExcluded('.ok/local/server.lock', REVEAL)).toBe(true);
      expect(filter.isExcluded('.ok/worktrees/checkout/README.md', REVEAL)).toBe(true);

      expect(filter.isDirExcluded('.git', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('node_modules', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.open-knowledge', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.openknowledge', REVEAL)).toBe(true);
      expect(filter.isExcluded('.git/objects/x.md', REVEAL)).toBe(true);
      expect(filter.isExcluded('node_modules/pkg/README.md', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.ok/templates/node_modules', REVEAL)).toBe(true);
      expect(filter.isExcluded('.ok/templates/node_modules/pkg/x.md', REVEAL)).toBe(true);

      expect(filter.isExcluded('.ok/.DS_Store', REVEAL)).toBe(true);
      expect(filter.isExcluded('.ok/templates/server.pem', REVEAL)).toBe(true);
      expect(filter.isExcluded('.ok/skills/demo/id_rsa', REVEAL)).toBe(true);
      expect(filter.isDirExcluded('.ok/skills/demo/.ssh', REVEAL)).toBe(true);

      expect(filter.isExcluded('__system__.md', REVEAL)).toBe(true);
      expect(filter.isExcluded('__config__/project.md', REVEAL)).toBe(true);
      expect(filter.isExcluded('__local__/project.md', REVEAL)).toBe(true);

      expect(filter.isPathIgnored('.ok/config.yml', REVEAL)).toBe(true);
      expect(filter.isPathIgnored('.ok/templates/daily.md', REVEAL)).toBe(false);

      expect(filter.isDirExcluded('.ok/templates', { showOk: true })).toBe(false);
      expect(filter.isDirExcluded('.ok/local', { showOk: true })).toBe(true);
      expect(filter.isExcluded('.ok/config.yml', { showOk: true })).toBe(true);
    }

    test('sync factory (createContentFilter)', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      assertShowOkReveal(filter);
    });

    test('async factory (createContentFilterAsync) mirrors the reveal', async () => {
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      assertShowOkReveal(filter);
    });
  });

  describe('reserved system doc names', () => {
    test('excludes __system__.md', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('__system__.md')).toBe(true);
    });

    test('does not exclude files with __system__ in non-identity positions', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('notes/__system__-notes.md')).toBe(false);
      expect(filter.isExcluded('docs/about-__system__.md')).toBe(false);
    });
  });

  describe('reserved config doc names', () => {
    test('excludes __config__/project.md', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('__config__/project.md')).toBe(true);
      expect(filter.isExcluded('__config__/project.mdx')).toBe(true);
    });

    test('excludes __user__/config.yml.md', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('__user__/config.yml.md')).toBe(true);
      expect(filter.isExcluded('__user__/config.yml.mdx')).toBe(true);
    });

    test('does not exclude unrelated files in __config__/ or __user__/ paths', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('__config__/something-else.md')).toBe(false);
      expect(filter.isExcluded('__user__/notes.md')).toBe(false);
      expect(filter.isExcluded('config-workspace.md')).toBe(false);
    });
  });

  describe('contentDir different from projectDir', () => {
    test('filter works when contentDir is a subdirectory of projectDir', () => {
      const contentDir = join(projectDir, 'content');
      mkdirSync(contentDir);
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\n');

      const filter = createContentFilter({ projectDir, contentDir });

      expect(filter.isExcluded('readme.md')).toBe(false);
    });

    test('root gitignore excludes paths mapped through contentRelPrefix', () => {
      const contentDir = join(projectDir, 'docs');
      mkdirSync(contentDir);
      mkdirSync(join(contentDir, 'generated'), { recursive: true });
      writeFileSync(join(projectDir, '.gitignore'), 'docs/generated/\n');

      const filter = createContentFilter({ projectDir, contentDir });

      expect(filter.isExcluded('generated/output.md')).toBe(true);
      expect(filter.isExcluded('guide.md')).toBe(false);
    });

    test('loads .gitignore at contentDir root when contentDir != projectDir', () => {
      const contentDir = join(projectDir, 'docs');
      mkdirSync(contentDir);
      writeFileSync(join(contentDir, '.gitignore'), 'drafts/\n');

      const filter = createContentFilter({ projectDir, contentDir });

      expect(filter.isExcluded('drafts/wip.md')).toBe(true);
      expect(filter.isExcluded('guide.md')).toBe(false);
    });

    test('loads .okignore at contentDir root when contentDir != projectDir', () => {
      const contentDir = join(projectDir, 'docs');
      mkdirSync(contentDir);
      writeFileSync(join(contentDir, '.okignore'), 'drafts/\n');

      const filter = createContentFilter({ projectDir, contentDir });

      expect(filter.isExcluded('drafts/wip.md')).toBe(true);
      expect(filter.isExcluded('guide.md')).toBe(false);
    });

    test('isDirExcluded works with split dirs', () => {
      const contentDir = join(projectDir, 'docs');
      mkdirSync(contentDir);
      writeFileSync(join(projectDir, '.gitignore'), 'docs/generated/\n');

      const filter = createContentFilter({ projectDir, contentDir });

      expect(filter.isDirExcluded('generated')).toBe(true);
      expect(filter.isDirExcluded('tutorials')).toBe(false);
    });

    test('handles contentDir completely outside projectDir (dotdot relative path)', async () => {
      const externalContentDir = await mkdtemp(join(tmpdir(), 'content-filter-external-'));
      try {
        mkdirSync(join(externalContentDir, 'sub'), { recursive: true });
        writeFileSync(join(externalContentDir, 'readme.md'), '# Hello');
        writeFileSync(join(externalContentDir, 'sub', 'nested.md'), '# Nested');

        const filter = createContentFilter({ projectDir, contentDir: externalContentDir });

        expect(filter.isExcluded('readme.md')).toBe(false);
        expect(filter.isExcluded('sub/nested.md')).toBe(false);
        expect(filter.isDirExcluded('sub')).toBe(false);
      } finally {
        await rm(externalContentDir, { recursive: true, force: true });
      }
    });
  });

  describe('sibling-asset inclusion rule (D11)', () => {
    test('includes allowlisted asset when sibling .md exists', () => {
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('docs/screenshot.png')).toBe(false);
      expect(filter.isExcluded('docs/photo.jpg')).toBe(false);
      expect(filter.isExcluded('docs/photo.jpeg')).toBe(false);
      expect(filter.isExcluded('docs/anim.gif')).toBe(false);
      expect(filter.isExcluded('docs/image.webp')).toBe(false);
    });

    test('includes SVG asset when sibling .md exists (D12)', () => {
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('docs/diagram.svg')).toBe(false);
    });

    test('excludes allowlisted asset when no sibling .md exists', () => {
      mkdirSync(join(projectDir, 'assets'));

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('assets/foo.png')).toBe(true);
    });

    function assertConfiguredAttachmentFolderAdmission(filter: ContentFilter): void {
      expect(filter.isExcluded('assets/foo.png')).toBe(false);
      expect(filter.isExcluded('assets/nested/photo.jpg')).toBe(false);
      expect(filter.isExcluded('notes/assets/foo.png')).toBe(true);
      expect(filter.isExcluded('assets/script.js')).toBe(true);
    }

    test('configured fixed attachment folder admits linkable assets without a sibling doc (sync)', () => {
      mkdirSync(join(projectDir, 'assets'), { recursive: true });
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        attachmentFolderPath: 'assets',
      });

      assertConfiguredAttachmentFolderAdmission(filter);
    });

    test('configured fixed attachment folder admits linkable assets without a sibling doc (async)', async () => {
      mkdirSync(join(projectDir, 'assets'), { recursive: true });
      const filter = await createContentFilterAsync({
        projectDir,
        contentDir: projectDir,
        attachmentFolderPath: 'assets',
      });

      assertConfiguredAttachmentFolderAdmission(filter);
    });

    test('doc-relative attachment folder admits the shape beneath note directories in both factories', async () => {
      mkdirSync(join(projectDir, 'notes'), { recursive: true });
      mkdirSync(join(projectDir, 'a', 'b'), { recursive: true });
      writeFileSync(join(projectDir, 'root.md'), '# Root');
      writeFileSync(join(projectDir, 'notes', 'note.md'), '# Note');
      writeFileSync(join(projectDir, 'a', 'b', 'note.md'), '# Deep');
      const filters = [
        createContentFilter({
          projectDir,
          contentDir: projectDir,
          attachmentFolderPath: './assets',
        }),
        await createContentFilterAsync({
          projectDir,
          contentDir: projectDir,
          attachmentFolderPath: './assets',
        }),
      ];

      for (const filter of filters) {
        expect(filter.isExcluded('assets/root.png')).toBe(false);
        expect(filter.isExcluded('notes/assets/nested.png')).toBe(false);
        expect(filter.isExcluded('a/b/assets/deep.webp')).toBe(false);
        expect(filter.isExcluded('a/b/other/deep.webp')).toBe(true);
        expect(filter.isExcluded('orphan/assets/unowned.png')).toBe(true);
      }
    });

    test('content-root attachment folder admits only root-level assets in both factories', async () => {
      const filters = [
        createContentFilter({
          projectDir,
          contentDir: projectDir,
          attachmentFolderPath: '/',
        }),
        await createContentFilterAsync({
          projectDir,
          contentDir: projectDir,
          attachmentFolderPath: '/',
        }),
      ];

      for (const filter of filters) {
        expect(filter.isExcluded('root.png')).toBe(false);
        expect(filter.isExcluded('assets/nested.png')).toBe(true);
      }
    });

    test('gitignore, secret, and .ok floors override configured attachment admission in both factories', async () => {
      writeFileSync(join(projectDir, '.gitignore'), 'assets/private/\n');
      const filters = [
        createContentFilter({
          projectDir,
          contentDir: projectDir,
          attachmentFolderPath: 'assets',
        }),
        await createContentFilterAsync({
          projectDir,
          contentDir: projectDir,
          attachmentFolderPath: 'assets',
        }),
      ];

      for (const filter of filters) {
        expect(filter.isExcluded('assets/public.png')).toBe(false);
        expect(filter.isExcluded('assets/private/ignored.png')).toBe(true);
        expect(filter.isExcluded('assets/signing.key')).toBe(true);
      }

      const okFilter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        attachmentFolderPath: '.ok/assets',
      });
      expect(okFilter.isDirExcluded('.ok/assets')).toBe(true);
      expect(okFilter.isExcluded('.ok/assets/private.png')).toBe(true);
    });

    test('live attachment-folder updates replace the previous admission shape in both factories', async () => {
      const filters = [
        createContentFilter({
          projectDir,
          contentDir: projectDir,
          attachmentFolderPath: 'assets',
        }),
        await createContentFilterAsync({
          projectDir,
          contentDir: projectDir,
          attachmentFolderPath: 'assets',
        }),
      ];

      for (const filter of filters) {
        expect(filter.isExcluded('assets/one.png')).toBe(false);
        expect(filter.isExcluded('media/two.png')).toBe(true);
        filter.setAttachmentFolderPath('media');
        expect(filter.isExcluded('assets/one.png')).toBe(true);
        expect(filter.isExcluded('media/two.png')).toBe(false);
        expect(() => filter.setAttachmentFolderPath('../escape')).toThrow(
          'Invalid attachment folder path',
        );
        expect(filter.isExcluded('media/two.png')).toBe(false);
      }
    });

    test('explicit default keeps the historical sibling-only rule', () => {
      mkdirSync(join(projectDir, 'assets'), { recursive: true });
      writeFileSync(join(projectDir, 'root.md'), '# Root');
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        attachmentFolderPath: './',
      });

      expect(filter.isExcluded('root.png')).toBe(false);
      expect(filter.isExcluded('assets/not-a-sibling.png')).toBe(true);
    });

    test('nested fixed attachment folder is content-root-relative', () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        attachmentFolderPath: 'media/uploads',
      });

      expect(filter.isExcluded('media/uploads/photo.png')).toBe(false);
      expect(filter.isExcluded('media/uploads/nested/photo.png')).toBe(false);
      expect(filter.isExcluded('notes/media/uploads/photo.png')).toBe(true);
    });

    test('excludes non-allowlisted extension even with sibling .md', () => {
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('docs/script.js')).toBe(true);
      expect(filter.isExcluded('docs/arbitrary.xyz')).toBe(true);
      expect(filter.isExcluded('docs/other.unknown')).toBe(true);
    });

    test('includes widened user-drop extensions when sibling .md exists (2026-04-24b)', () => {
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('docs/clip.m4v')).toBe(false);
      expect(filter.isExcluded('docs/clip.mkv')).toBe(false);
      expect(filter.isExcluded('docs/song.flac')).toBe(false);
      expect(filter.isExcluded('docs/spec.docx')).toBe(false);
      expect(filter.isExcluded('docs/sheet.xlsx')).toBe(false);
      expect(filter.isExcluded('docs/data.csv')).toBe(false);
      expect(filter.isExcluded('docs/notes.txt')).toBe(false);
      expect(filter.isExcluded('docs/config.json')).toBe(false);
    });

    test('.base and .canvas files are admitted when a sibling .md exists', () => {
      mkdirSync(join(projectDir, 'vault'));
      writeFileSync(join(projectDir, 'vault', 'note.md'), '# Note');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('vault/Characters.base')).toBe(false);
      expect(filter.isExcluded('vault/Board.canvas')).toBe(false);
      expect(filter.isExcluded('standalone/Characters.base')).toBe(true);
    });

    test('.okignore exclusion takes precedence over sibling-asset rule', () => {
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');
      writeFileSync(join(projectDir, '.okignore'), '**/*.png\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('docs/screenshot.png')).toBe(true);
    });

    test('gitignore takes precedence over sibling-asset rule', () => {
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');
      writeFileSync(join(projectDir, '.gitignore'), '*.png\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('docs/screenshot.png')).toBe(true);
    });

    test('refcount lifecycle: increment then decrement returns to original', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('docs/screenshot.png')).toBe(true);

      filter.incrementMdDir('docs');
      expect(filter.isExcluded('docs/screenshot.png')).toBe(false);

      filter.decrementMdDir('docs');
      expect(filter.isExcluded('docs/screenshot.png')).toBe(true);
    });

    test('refcount handles multiple .md files in same directory', () => {
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'a.md'), '# A');
      writeFileSync(join(projectDir, 'docs', 'b.md'), '# B');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('docs/img.png')).toBe(false);

      filter.decrementMdDir('docs');
      expect(filter.isExcluded('docs/img.png')).toBe(false);

      filter.decrementMdDir('docs');
      expect(filter.isExcluded('docs/img.png')).toBe(true);
    });

    test('sibling-asset rule works for root-level files', () => {
      writeFileSync(join(projectDir, 'readme.md'), '# README');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('logo.png')).toBe(false);
    });

    test('sibling-asset rule with contentDir different from projectDir', () => {
      const contentDir = join(projectDir, 'content');
      mkdirSync(join(contentDir, 'docs'), { recursive: true });
      writeFileSync(join(contentDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir });

      expect(filter.isExcluded('docs/screenshot.png')).toBe(false);
      expect(filter.isExcluded('docs/script.js')).toBe(true);
    });
  });

  describe('isPathIgnored', () => {
    test('admits asset in directory without sibling .md (D11 not applied)', () => {
      mkdirSync(join(projectDir, 'assets'));

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('assets/logo.png')).toBe(true);
      expect(filter.isPathIgnored('assets/logo.png')).toBe(false);
    });

    test('rejects the reserved system doc name', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isPathIgnored('__system__.md')).toBe(true);
    });

    test('rejects reserved config doc names', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isPathIgnored('__config__/project.md')).toBe(true);
      expect(filter.isPathIgnored('__user__/config.yml.md')).toBe(true);
      expect(filter.isPathIgnored('__local__/project.md')).toBe(true);
    });

    test('rejects paths inside BUILTIN_SKIP_DIRS', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isPathIgnored('node_modules/pkg/img.png')).toBe(true);
      expect(filter.isPathIgnored('dist/output.png')).toBe(true);
      expect(filter.isPathIgnored('.git/objects/pack/foo.png')).toBe(true);
      expect(filter.isPathIgnored('.ok/templates/img.png')).toBe(true);
      expect(filter.isPathIgnored('a/b/node_modules/c/img.png')).toBe(true);
    });

    test('rejects paths matched by .gitignore patterns', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'tmp/\n*.bak.png\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isPathIgnored('tmp/foo.png')).toBe(true);
      expect(filter.isPathIgnored('docs/photo.bak.png')).toBe(true);
      expect(filter.isPathIgnored('docs/photo.png')).toBe(false);
    });

    test('rejects paths matched by .okignore patterns', () => {
      writeFileSync(join(projectDir, '.okignore'), 'private/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isPathIgnored('private/diagram.png')).toBe(true);
      expect(filter.isPathIgnored('public/diagram.png')).toBe(false);
    });

    test('admits everything except BUILTIN_SKIP_DIRS when contentDir is outside projectDir', async () => {
      const contentDir = await mkdtemp(join(tmpdir(), 'content-filter-outside-'));
      try {
        writeFileSync(join(projectDir, '.gitignore'), 'tmp/\n');

        const filter = createContentFilter({ projectDir, contentDir });

        expect(filter.isPathIgnored('tmp/foo.png')).toBe(false);
        expect(filter.isPathIgnored('node_modules/foo.png')).toBe(true);
      } finally {
        await rm(contentDir, { recursive: true, force: true });
      }
    });

    test('matches isExcluded for path-level rejections (no sibling-asset case)', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'private/\n');
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      const cases = [
        '__system__.md',
        '__config__/project.md',
        'node_modules/pkg/img.png',
        'private/diagram.png',
      ];
      for (const p of cases) {
        expect(filter.isExcluded(p), p).toBe(true);
        expect(filter.isPathIgnored(p), p).toBe(true);
      }

      expect(filter.isExcluded('docs/screenshot.png')).toBe(false);
      expect(filter.isPathIgnored('docs/screenshot.png')).toBe(false);
    });
  });

  describe('rebuildIgnorePatterns', () => {
    test('concurrent rebuild calls coalesce into one flight plus one trailing run', async () => {
      let scans = 0;
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        rescanInPlaceSkillDirs: () => {
          scans += 1;
          return new Set<string>();
        },
      });
      const baseline = scans;
      await Promise.all(Array.from({ length: 6 }, () => filter.rebuildIgnorePatterns()));
      expect(scans - baseline).toBeLessThanOrEqual(2);
      expect(scans - baseline).toBeGreaterThanOrEqual(1);
      const afterBurst = scans;
      await filter.rebuildIgnorePatterns();
      expect(scans).toBe(afterBurst + 1);
    });

    test('reflects new patterns after .okignore is created on disk', async () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('drafts/foo.md')).toBe(false);

      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      const result = await filter.rebuildIgnorePatterns();

      expect(result.ok).toBe(true);
      expect(filter.isExcluded('drafts/foo.md')).toBe(true);
      expect(filter.isExcluded('docs/guide.md')).toBe(false);
    });

    test('removes patterns when .okignore is deleted on disk', async () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('drafts/foo.md')).toBe(true);

      rmSync(join(projectDir, '.okignore'));
      await filter.rebuildIgnorePatterns();

      expect(filter.isExcluded('drafts/foo.md')).toBe(false);
    });

    test('refreshes watcher globs when patterns change', async () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\ndist/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.getWatcherIgnoreGlobs()).toContain('dist/');
      expect(filter.getWatcherIgnoreGlobs()).toContain('drafts/');

      writeFileSync(join(projectDir, '.okignore'), 'archive/\nnode_modules/\n');
      await filter.rebuildIgnorePatterns();

      const globs = filter.getWatcherIgnoreGlobs();
      expect(globs).toContain('node_modules/');
      expect(globs).not.toContain('dist/');
      expect(globs).toContain('archive/');
    });

    test('refreshes sibling-asset dirCount against new exclusions', async () => {
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('docs/screenshot.png')).toBe(false);

      writeFileSync(join(projectDir, '.okignore'), 'docs/\n');
      await filter.rebuildIgnorePatterns();

      expect(filter.isExcluded('docs/guide.md')).toBe(true);
      expect(filter.isExcluded('docs/screenshot.png')).toBe(true);
    });

    test('returns RebuildResult with success branch and bounded attrs', async () => {
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\nscratch/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      const result = await filter.rebuildIgnorePatterns();

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.patternCount).toBe(3);
      expect(result.nestedFileCount).toBe(0);
      expect(typeof result.bytes).toBe('number');
      expect(result.bytes).toBeGreaterThan(0);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('async factory reports root ignore pattern count, not retained watcher globs', async () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\nscratch/\n');

      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });
      const result = await filter.rebuildIgnorePatterns();

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.patternCount).toBe(2);
      expect(filter.getWatcherIgnoreGlobs()).toContain('drafts/');
      expect(filter.getWatcherIgnoreGlobs()).toContain('scratch/');
    });

    test('counts nested ignore files correctly', async () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      mkdirSync(join(projectDir, 'subdir'));
      writeFileSync(join(projectDir, 'subdir', '.okignore'), 'private.md\n');
      mkdirSync(join(projectDir, 'subdir', 'deep'), { recursive: true });
      writeFileSync(join(projectDir, 'subdir', 'deep', '.gitignore'), 'tmp/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      const result = await filter.rebuildIgnorePatterns();

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.nestedFileCount).toBe(2);
    });

    test('fires onAfterRebuild on success', async () => {
      let calls = 0;
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        onAfterRebuild: () => {
          calls++;
        },
      });

      expect(calls).toBe(0);

      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      const result = await filter.rebuildIgnorePatterns();

      expect(result.ok).toBe(true);
      expect(calls).toBe(1);
    });

    test('does not fire onAfterRebuild on error (state rolls back)', async () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      let calls = 0;
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        onAfterRebuild: () => {
          calls++;
        },
      });

      const sampleProto = Object.getPrototypeOf(ignore());
      const addSpy = vi.spyOn(sampleProto, 'add').mockImplementationOnce(() => {
        throw new Error('forced ignore.add failure');
      });

      try {
        const result = await filter.rebuildIgnorePatterns();
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.error.message).toContain('forced ignore.add failure');
        expect(calls).toBe(0);
        expect(filter.isExcluded('drafts/foo.md')).toBe(true);
        expect(filter.isExcluded('docs/guide.md')).toBe(false);
      } finally {
        addSpy.mockRestore();
      }
    });

    test('rolls back state on error (ig + watcherGlobs + dirCount)', async () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\ndist/\n');
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('drafts/x.md')).toBe(true);
      expect(filter.isExcluded('docs/screenshot.png')).toBe(false);
      expect(filter.getWatcherIgnoreGlobs()).toContain('dist/');

      const sampleProto = Object.getPrototypeOf(ignore());
      const addSpy = vi.spyOn(sampleProto, 'add').mockImplementationOnce(() => {
        throw new Error('boom');
      });

      writeFileSync(join(projectDir, '.okignore'), 'archive/\nnode_modules/\n');

      try {
        const result = await filter.rebuildIgnorePatterns();
        expect(result.ok).toBe(false);

        expect(filter.isExcluded('drafts/x.md')).toBe(true);
        expect(filter.isExcluded('archive/x.md')).toBe(false);
        expect(
          filter.isExcluded('drafts/x.md', {
            bypassFilters: true,
            respectOkignore: true,
          }),
        ).toBe(true);
        expect(filter.getWatcherIgnoreGlobs()).toContain('dist/');
        expect(filter.getWatcherIgnoreGlobs()).not.toContain('node_modules/');
        expect(filter.isExcluded('docs/screenshot.png')).toBe(false);
      } finally {
        addSpy.mockRestore();
      }
    });

    test('callback throws are logged but do not roll back the rebuild', async () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        onAfterRebuild: () => {
          throw new Error('callback explosion');
        },
      });

      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      const result = await filter.rebuildIgnorePatterns();

      expect(result.ok).toBe(true);
      expect(filter.isExcluded('drafts/foo.md')).toBe(true);
    });
  });

  describe('rebuildIgnorePatterns telemetry', () => {
    let exporter: InMemorySpanExporter;
    let provider: BasicTracerProvider;

    beforeEach(() => {
      exporter = new InMemorySpanExporter();
      provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      trace.setGlobalTracerProvider(provider);
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      installTestLoggers();
    });

    afterEach(async () => {
      await provider.shutdown();
      trace.disable();
      metrics.disable();
      context.disable();
      loggerFactory.reset();
    });

    test('emits one config.ignore.rebuild span per call with bounded attrs', async () => {
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\nscratch/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      const result = await filter.rebuildIgnorePatterns();
      expect(result.ok).toBe(true);

      const spans = exporter
        .getFinishedSpans()
        .filter((s: ReadableSpan) => s.name === 'config.ignore.rebuild');
      expect(spans.length).toBe(1);
      const span = spans[0];
      if (!span) throw new Error('no span');

      const attrs = span.attributes;
      expect(attrs['ok.ignore.pattern_count']).toBe(3);
      expect(attrs['ok.ignore.nested_file_count']).toBe(0);
      expect(typeof attrs['ok.ignore.bytes']).toBe('number');

      const allowedAttrKeys = new Set([
        'ok.ignore.pattern_count',
        'ok.ignore.nested_file_count',
        'ok.ignore.bytes',
      ]);
      for (const key of Object.keys(attrs)) {
        expect(allowedAttrKeys.has(key)).toBe(true);
      }
    });

    test('failed rebuild still emits the span, with ERROR status', async () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      const sampleProto = Object.getPrototypeOf(ignore());
      const addSpy = vi.spyOn(sampleProto, 'add').mockImplementationOnce(() => {
        throw new Error('boom');
      });

      try {
        const result = await filter.rebuildIgnorePatterns();
        expect(result.ok).toBe(false);
      } finally {
        addSpy.mockRestore();
      }

      const spans = exporter
        .getFinishedSpans()
        .filter((s: ReadableSpan) => s.name === 'config.ignore.rebuild');
      expect(spans.length).toBe(1);
      const span = spans[0];
      if (!span) throw new Error('no span');
      expect(span.status).toBeDefined();
    });
  });

  describe('rebuildIgnorePatterns performance gate (NFR Performance)', () => {
    test('rebuild on N=1000-doc workspace completes well under 500ms', async () => {
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      for (let d = 0; d < 50; d++) {
        const dir = join(projectDir, `folder-${d}`);
        mkdirSync(dir);
        for (let f = 0; f < 20; f++) {
          writeFileSync(join(dir, `doc-${f}.md`), '# x');
        }
        if (d % 10 === 0) {
          writeFileSync(join(dir, '.okignore'), 'tmp/\n');
        }
      }

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      await filter.rebuildIgnorePatterns();

      const samples: number[] = [];
      const runs = 5;
      for (let i = 0; i < runs; i++) {
        const result = await filter.rebuildIgnorePatterns();
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('unreachable');
        samples.push(result.durationMs);
      }
      const max = Math.max(...samples);
      expect(max).toBeLessThan(500);
    });
  });

  describe('FR15 default-shape regression', () => {
    test('default project (gitignore + no .okignore + no content.* keys) indexes the same .md/.mdx set as before the rename', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');
      writeFileSync(join(projectDir, 'docs', 'overview.mdx'), '# Overview');
      mkdirSync(join(projectDir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(projectDir, 'node_modules', 'pkg', 'README.md'), '# Pkg');
      writeFileSync(join(projectDir, 'README.md'), '# Project');
      writeFileSync(join(projectDir, 'script.ts'), 'export {}');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('README.md')).toBe(false);
      expect(filter.isExcluded('docs/guide.md')).toBe(false);
      expect(filter.isExcluded('docs/overview.mdx')).toBe(false);

      expect(filter.isExcluded('node_modules/pkg/README.md')).toBe(true);
      expect(filter.isExcluded('script.ts')).toBe(true);
    });
  });

  describe('bypassFilters mode (Show All Files — FR6 / D12)', () => {
    test('admits .gitignored files', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'secrets/\n*.log\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('secrets/api-key.md')).toBe(true);
      expect(filter.isExcluded('debug.log')).toBe(true);

      expect(filter.isExcluded('secrets/api-key.md', { bypassFilters: true })).toBe(false);
      expect(filter.isExcluded('debug.log', { bypassFilters: true })).toBe(false);
    });

    test('admits .okignored files', () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('drafts/wip.md')).toBe(true);
      expect(filter.isExcluded('drafts/wip.md', { bypassFilters: true })).toBe(false);
    });

    test('respectOkignore keeps .okignore patterns active while admitting .gitignored files', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\n');
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('dist/out.md', { bypassFilters: true })).toBe(false);
      expect(filter.isExcluded('drafts/wip.md', { bypassFilters: true })).toBe(false);

      const showAllOpts = { bypassFilters: true, respectOkignore: true } as const;
      expect(filter.isExcluded('dist/out.md', showAllOpts)).toBe(false);
      expect(filter.isExcluded('drafts/wip.md', showAllOpts)).toBe(true);
      expect(filter.isDirExcluded('dist', showAllOpts)).toBe(false);
      expect(filter.isDirExcluded('drafts', showAllOpts)).toBe(true);
    });

    test('admits content-bearing BUILTIN_SKIP_DIRS (dist) in bypass mode', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('apps/web/dist/index.md')).toBe(true);

      expect(filter.isExcluded('apps/web/dist/index.md', { bypassFilters: true })).toBe(false);
    });

    test('admits non-md/non-asset extensions (.ts, .py, .sh) only under bypass', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('src/index.ts')).toBe(true);
      expect(filter.isExcluded('scripts/build.sh')).toBe(true);
      expect(filter.isExcluded('analysis.py')).toBe(true);

      expect(filter.isExcluded('src/index.ts', { bypassFilters: true })).toBe(false);
      expect(filter.isExcluded('scripts/build.sh', { bypassFilters: true })).toBe(false);
      expect(filter.isExcluded('analysis.py', { bypassFilters: true })).toBe(false);
    });

    test('STOP rule preserved — reserved system + config doc names stay hidden in bypass mode', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('__system__.md', { bypassFilters: true })).toBe(true);
      expect(filter.isExcluded('__config__/project.md', { bypassFilters: true })).toBe(true);
      expect(filter.isExcluded('__config__/project.mdx', { bypassFilters: true })).toBe(true);
      expect(filter.isExcluded('__config__/okignore.md', { bypassFilters: true })).toBe(true);
      expect(filter.isExcluded('__user__/config.yml.md', { bypassFilters: true })).toBe(true);
      expect(filter.isExcluded('__local__/project.md', { bypassFilters: true })).toBe(true);
    });

    test('isDirExcluded admits gitignored + content-bearing skip-dirs in bypass mode', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'drafts/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('drafts')).toBe(true);
      expect(filter.isDirExcluded('dist')).toBe(true);

      expect(filter.isDirExcluded('drafts', { bypassFilters: true })).toBe(false);
      expect(filter.isDirExcluded('dist', { bypassFilters: true })).toBe(false);
    });

    test('isPathIgnored preserves STOP rule in bypass mode', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'private/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isPathIgnored('private/secret.md')).toBe(true);
      expect(filter.isPathIgnored('docs/readme.md')).toBe(false);
      expect(filter.isPathIgnored('__system__.md')).toBe(true);

      expect(filter.isPathIgnored('private/secret.md', { bypassFilters: true })).toBe(false);
      expect(filter.isPathIgnored('__system__.md', { bypassFilters: true })).toBe(true);
      expect(filter.isPathIgnored('__config__/project.md', { bypassFilters: true })).toBe(true);
    });

    test('default behavior (no opts) byte-equivalent to opts.bypassFilters === false', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      const paths = ['dist/out.md', 'docs/guide.md', '__system__.md', 'script.ts'];
      for (const p of paths) {
        expect(filter.isExcluded(p)).toBe(filter.isExcluded(p, { bypassFilters: false }));
        expect(filter.isDirExcluded(p)).toBe(filter.isDirExcluded(p, { bypassFilters: false }));
        expect(filter.isPathIgnored(p)).toBe(filter.isPathIgnored(p, { bypassFilters: false }));
      }
    });
  });

  describe('singleDocRelPath (single-file scope, D3)', () => {
    test('isExcluded admits only the target doc; every sibling excluded', () => {
      writeFileSync(join(projectDir, 'notes.md'), '# notes');
      writeFileSync(join(projectDir, 'other.md'), '# other');
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });

      expect(filter.isExcluded('notes.md')).toBe(false);
      expect(filter.isExcluded('other.md')).toBe(true);
      expect(filter.isExcluded('sub/deep.md')).toBe(true);
    });

    test('isDirExcluded prunes every directory for a bare-basename target', () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });
      expect(filter.isDirExcluded('sub')).toBe(true);
      expect(filter.isDirExcluded('sub/nested')).toBe(true);
    });

    test('isDirExcluded descends only the ancestor chain of a nested target', () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'a/b/doc.md',
      });
      expect(filter.isDirExcluded('a')).toBe(false);
      expect(filter.isDirExcluded('a/b')).toBe(false);
      expect(filter.isDirExcluded('a/other')).toBe(true);
      expect(filter.isDirExcluded('other')).toBe(true);
      expect(filter.isExcluded('a/b/doc.md')).toBe(false);
      expect(filter.isExcluded('a/b/sibling.md')).toBe(true);
    });

    test('isPathIgnored is UNAFFECTED — referenced sibling assets still serve (STOP_IF)', () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });
      expect(filter.isPathIgnored('sibling.png')).toBe(false);
      expect(filter.isPathIgnored('notes.md')).toBe(false);
      expect(filter.isPathIgnored('.git/config')).toBe(true);
      expect(filter.isPathIgnored('__system__.md')).toBe(true);
    });

    test('scope holds even under bypassFilters (single-file sidebar is hidden, but defense-in-depth)', () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });
      expect(filter.isExcluded('other.md', { bypassFilters: true })).toBe(true);
      expect(filter.isExcluded('notes.md', { bypassFilters: true })).toBe(false);
      expect(filter.isDirExcluded('sub', { bypassFilters: true })).toBe(true);
    });

    test('split projectDir/contentDir (ephemeral shape) scopes correctly', async () => {
      const realParent = await mkdtemp(join(tmpdir(), 'content-filter-real-'));
      try {
        writeFileSync(join(realParent, 'notes.md'), '# notes');
        writeFileSync(join(realParent, 'secret.md'), '# secret');
        const filter = createContentFilter({
          projectDir,
          contentDir: realParent,
          singleDocRelPath: 'notes.md',
        });
        expect(filter.isExcluded('notes.md')).toBe(false);
        expect(filter.isExcluded('secret.md')).toBe(true);
        expect(filter.isPathIgnored('sibling.png')).toBe(false);
      } finally {
        await rm(realParent, { recursive: true, force: true });
      }
    });

    test('async factory mirrors the sync single-file scope', async () => {
      writeFileSync(join(projectDir, 'notes.md'), '# notes');
      writeFileSync(join(projectDir, 'other.md'), '# other');
      const filter = await createContentFilterAsync({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });
      expect(filter.isExcluded('notes.md')).toBe(false);
      expect(filter.isExcluded('other.md')).toBe(true);
      expect(filter.isDirExcluded('sub')).toBe(true);
      expect(filter.isPathIgnored('sibling.png')).toBe(false);
    });
  });

  describe('descendant projects', () => {
    function seedTwoLevelFixture(): void {
      writeFileSync(join(projectDir, 'ancestor.md'), '# ancestor');
      mkdirSync(join(projectDir, 'notes'), { recursive: true });
      writeFileSync(join(projectDir, 'notes', 'own.md'), '# own');

      mkdirSync(join(projectDir, 'nested', '.ok'), { recursive: true });
      writeFileSync(
        join(projectDir, 'nested', '.ok', 'config.yml'),
        'autoSync:\n  enabled: false\n',
      );
      writeFileSync(join(projectDir, 'nested', 'inside.md'), '# inside');
      mkdirSync(join(projectDir, 'nested', 'deep'), { recursive: true });
      writeFileSync(join(projectDir, 'nested', 'deep', 'deeper.md'), '# deeper');

      mkdirSync(join(projectDir, 'rules', '.ok', 'templates'), { recursive: true });
      writeFileSync(join(projectDir, 'rules', '.ok', 'frontmatter.yml'), 'type: note\n');
      writeFileSync(join(projectDir, 'rules', '.ok', 'templates', 'note.md'), '# template');
      writeFileSync(join(projectDir, 'rules', 'ruled.md'), '# ruled');
    }

    test('excludes a descendant project root and everything under it', () => {
      seedTwoLevelFixture();
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('nested')).toBe(true);
      expect(filter.isDirExcluded('nested/deep')).toBe(true);
      expect(filter.isExcluded('nested/inside.md')).toBe(true);
      expect(filter.isExcluded('nested/deep/deeper.md')).toBe(true);
      expect(filter.isExcluded('nested/.ok/skills/demo/SKILL.md')).toBe(true);

      expect(filter.isExcluded('ancestor.md')).toBe(false);
      expect(filter.isExcluded('notes/own.md')).toBe(false);
      expect(filter.isDirExcluded('notes')).toBe(false);
    });

    test('a nested `.ok` carrying only folder metadata is not a project', () => {
      seedTwoLevelFixture();
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('rules')).toBe(false);
      expect(filter.isExcluded('rules/ruled.md')).toBe(false);
      expect(filter.isExcluded('rules/.ok/templates/note.md')).toBe(false);
    });

    test('single-file scope is unaffected — the one admitted doc stays admitted', () => {
      seedTwoLevelFixture();
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'nested/inside.md',
      });

      expect(filter.isExcluded('nested/inside.md')).toBe(false);
      expect(filter.isDirExcluded('nested')).toBe(false);
    });

    test('detects the descendant root under either path base', () => {
      mkdirSync(join(projectDir, 'content', 'docs', '.ok'), { recursive: true });
      writeFileSync(join(projectDir, 'content', 'docs', '.ok', 'config.yml'), 'x: 1\n');
      writeFileSync(join(projectDir, 'content', 'docs', 'inside.md'), '# inside');
      mkdirSync(join(projectDir, 'content', 'guides', '.ok'), { recursive: true });
      writeFileSync(join(projectDir, 'content', 'guides', '.ok', 'frontmatter.yml'), 'icon: map\n');
      writeFileSync(join(projectDir, 'content', 'guides', 'ruled.md'), '# ruled');

      const filter = createContentFilter({
        projectDir,
        contentDir: join(projectDir, 'content'),
      });
      const projectScope = { syncScope: { pathBase: 'project' } } as const;

      expect(filter.isDirExcluded('docs')).toBe(true);
      expect(filter.isExcluded('docs/inside.md')).toBe(true);
      expect(filter.isDirExcluded('content/docs', projectScope)).toBe(true);
      expect(filter.isExcluded('content/docs/inside.md', projectScope)).toBe(true);

      expect(filter.isDirExcluded('guides')).toBe(false);
      expect(filter.isDirExcluded('content/guides', projectScope)).toBe(false);
      expect(filter.isExcluded('content/guides/.ok/frontmatter.yml', projectScope)).toBe(false);
    });

    test('async factory mirrors the descendant-project floor', async () => {
      seedTwoLevelFixture();
      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });

      expect(filter.isDirExcluded('nested')).toBe(true);
      expect(filter.isExcluded('nested/inside.md')).toBe(true);
      expect(filter.isExcluded('ancestor.md')).toBe(false);
      expect(filter.isDirExcluded('rules')).toBe(false);
      expect(filter.isExcluded('rules/ruled.md')).toBe(false);
    });
  });
});
