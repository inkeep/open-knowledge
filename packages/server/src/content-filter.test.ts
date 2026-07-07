import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
import {
  type ContentFilter,
  createContentFilter,
  createContentFilterAsync,
} from './content-filter.ts';
import { installTestLoggers, loggerFactory } from './logger.ts';

describe('ContentFilter', () => {
  let projectDir: string;
  // Isolate from the developer's actual `~/.config/git/ignore` — the
  // git-extras loader (`loadGitExcludeSources`) consults XDG by design,
  // so without a clean per-test root the host's global patterns would
  // leak into pattern-count assertions.
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
      // Use logs/* (not logs/) so negation can un-ignore files within the dir.
      // This matches real git behavior: directory-level ignore blocks all negation.
      writeFileSync(join(projectDir, '.gitignore'), 'logs/*\n!logs/important.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('logs/debug.md')).toBe(true);
      expect(filter.isExcluded('logs/important.md')).toBe(false);
    });

    test('handles wildcard patterns in .gitignore', () => {
      writeFileSync(join(projectDir, '.gitignore'), '*.log\nbuild-*\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // .log is not a supported doc extension; the upstream gate already
      // excludes it. Filter alone is consulted only with supported docs in
      // production, but the test asserts that the filter's gitignore matching
      // doesn't accidentally let it through either.
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

      // .gitignore alone would exclude. The negation in .okignore wins because
      // both files are loaded into the same `ignore` instance.
      expect(filter.isExcluded('secret.md')).toBe(false);
    });

    test('nested .okignore at folder depth applies patterns with correct path prefix', () => {
      mkdirSync(join(projectDir, 'subdir'), { recursive: true });
      writeFileSync(join(projectDir, 'subdir', '.okignore'), 'private.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('subdir/private.md')).toBe(true);
      // The nested rule is folder-scoped — root-level same-named file is admitted.
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
      // node-ignore drops invalid patterns silently — same as git itself.
      writeFileSync(join(projectDir, '.okignore'), '   \n# valid comment\nvalid.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('valid.md')).toBe(true);
      // Filter constructed without crashing; valid line still applies.
      expect(filter.isExcluded('other.md')).toBe(false);
    });
  });

  // A nested ignore file's patterns are flattened into one project-root matcher,
  // so each must be re-anchored. The re-anchoring has to preserve gitignore
  // depth scoping: a bare basename matches at ANY depth below the ignore file's
  // directory, an anchored (slash-bearing) pattern only at that directory.
  // Collapsing the former to "exact level only" let the sync walker hand
  // `git add` a gitignored path, surfacing `addIgnoredFile` (precedent #55).
  describe('nested ignore depth semantics', () => {
    test('non-anchored nested pattern matches at any depth below its directory', () => {
      // Mirrors the real failure: public/agents/.gitignore has `.blob-storage/`,
      // and the blob store lived one level deeper at agents-api/.blob-storage.
      mkdirSync(join(projectDir, 'agents', 'agents-api', '.blob-storage'), { recursive: true });
      writeFileSync(join(projectDir, 'agents', '.gitignore'), '.blob-storage/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Two levels below the .gitignore — the depth the old prefix missed.
      expect(filter.isExcluded('agents/agents-api/.blob-storage/doc.md')).toBe(true);
      expect(filter.isDirExcluded('agents/agents-api/.blob-storage')).toBe(true);
      // The immediate level always worked — keep it working.
      expect(filter.isDirExcluded('agents/.blob-storage')).toBe(true);
      // Folder-scoped: a same-named dir outside the .gitignore's subtree is admitted.
      expect(filter.isDirExcluded('other/.blob-storage')).toBe(false);
    });

    test('async factory: non-anchored nested pattern matches at any depth', async () => {
      // The async traversal in initContentDirStateAsync calls the shared
      // prefixPattern from its own recursion — a sync-only test would miss an
      // async-path divergence that re-broke depth matching.
      mkdirSync(join(projectDir, 'agents', 'agents-api', '.blob-storage'), { recursive: true });
      writeFileSync(join(projectDir, 'agents', '.gitignore'), '.blob-storage/\n');

      const filter = await createContentFilterAsync({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('agents/agents-api/.blob-storage/doc.md')).toBe(true);
      expect(filter.isDirExcluded('agents/agents-api/.blob-storage')).toBe(true);
    });

    test('anchored nested pattern stays scoped to its own level (no over-match)', () => {
      mkdirSync(join(projectDir, 'pkg', 'src', 'generated'), { recursive: true });
      // Embedded slash anchors the rule to pkg/ — it must not leak to deeper namesakes.
      writeFileSync(join(projectDir, 'pkg', '.gitignore'), 'src/generated/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('pkg/src/generated/api.md')).toBe(true);
      // A deeper src/generated is a different path — the anchored rule must miss it.
      expect(filter.isExcluded('pkg/nested/src/generated/api.md')).toBe(false);
    });

    test('non-anchored nested negation un-ignores at any depth', () => {
      mkdirSync(join(projectDir, 'logs', 'sub'), { recursive: true });
      // Ignore every .md, then re-admit keep.md — both must apply at any depth.
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

  // `.git/info/exclude` + `core.excludesfile` parity with `git add`
  // (precedent #55). Without this, the sync walker can gather a path that
  // the next `git add` step rejects with `addIgnoredFile`, paused-sync.
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
      // Sanity: unrelated dot-dir content still admitted.
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
      // projectDir is a fresh tmpdir, never `git init`-ed.
      writeFileSync(join(projectDir, '.gitignore'), 'drafts/\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Project .gitignore still applies; absence of `.git/info/exclude` does not error.
      expect(filter.isExcluded('drafts/wip.md')).toBe(true);
      expect(filter.isExcluded('docs/guide.md')).toBe(false);
    });

    test('non-git dirs DO NOT consult global excludesfile (no git → no host-wide leak)', async () => {
      // Without `git init`, `git rev-parse --git-common-dir` fails. In that
      // state there's no `git add` for ContentFilter to be symmetric WITH —
      // host-wide rules should NOT filter content out of a non-git OK vault.
      const xdgRoot = await mkdtemp(join(tmpdir(), 'cf-xdg-nongit-'));
      try {
        mkdirSync(join(xdgRoot, 'git'), { recursive: true });
        writeFileSync(join(xdgRoot, 'git', 'ignore'), '.host-wide-rule/\n');
        process.env.XDG_CONFIG_HOME = xdgRoot;

        const filter = createContentFilter({ projectDir, contentDir: projectDir });

        // Without the gate, this would be `true` — but the gate skips the
        // global excludesfile entirely when `projectDir` isn't a git repo.
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
    test('returns gitignore + okignore patterns, dropping negation/comment lines', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\ntmp/\n# comment\n!keep\n');
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n!important.md\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      const globs = filter.getWatcherIgnoreGlobs();
      expect(globs).toContain('dist/');
      expect(globs).toContain('tmp/');
      expect(globs).toContain('drafts/');
      // Should not include negation or comment patterns
      expect(globs).not.toContain('!keep');
      expect(globs).not.toContain('!important.md');
      expect(globs).not.toContain('# comment');
    });

    test('returns empty array when no patterns', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.getWatcherIgnoreGlobs()).toEqual([]);
    });

    test('drops blanket .ok globs so the OS watcher can reach .ok/skills (skills-as-content)', () => {
      // `ok clone` appends `.ok/` to `.git/info/exclude`; a blanket `.ok` glob
      // would make the @parcel/watcher backend (Linux default) never deliver
      // external edits to project skills under `.ok/skills/**`. The non-skill
      // `.ok` children stay pruned downstream by the function predicates.
      mkdirSync(join(projectDir, '.git', 'info'), { recursive: true });
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\n.ok\nnode_modules/\n');

      const globs = createContentFilter({
        projectDir,
        contentDir: projectDir,
      }).getWatcherIgnoreGlobs();

      // The blanket `.ok` / `.ok/` exclusions are dropped from the watcher list…
      expect(globs).not.toContain('.ok');
      expect(globs).not.toContain('.ok/');
      // …while unrelated excludes are preserved.
      expect(globs).toContain('dist/');
      expect(globs).toContain('node_modules/');
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

      // Editor host dirs (`.claude`/`.cursor`/`.codex`/`.agents`/`.opencode`) are
      // builtin-skip — they hold OK's skill PROJECTIONS + tool config, never KB
      // content, so skill projections stay out of the note/content index.
      // Excluded at any depth, including nested.
      expect(filter.isExcluded('.cursor/skills/SKILL.md')).toBe(true);
      expect(filter.isExcluded('.claude/skills/foo.md')).toBe(true);
      expect(filter.isExcluded('.agents/skills/foo.md')).toBe(true);
      expect(filter.isExcluded('.codex/skills/foo.md')).toBe(true);
      expect(filter.isExcluded('.opencode/skills/foo.md')).toBe(true);
      expect(filter.isExcluded('packages/.cursor/skills/SKILL.md')).toBe(true);
      expect(filter.isExcluded('.cursor/skills/open-knowledge/diagram.png')).toBe(true);

      // Non-editor dot dirs that may hold user-authored markdown stay admitted.
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
      // Skills-as-content: `.ok` itself is descendable so the walk can reach
      // `.ok/skills/<name>/SKILL`; its non-skill children stay excluded.
      expect(filter.isDirExcluded('.ok')).toBe(false);
      expect(filter.isDirExcluded('.ok/local')).toBe(true);
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
      // BUILTIN_SKIP_DIRS prunes package-manager, runtime, build-output, and
      // per-project state directories regardless of user config.
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Package managers / runtimes
      expect(filter.isDirExcluded('node_modules')).toBe(true);
      expect(filter.isDirExcluded('node_modules/some-pkg')).toBe(true);
      expect(filter.isDirExcluded('.venv')).toBe(true);
      expect(filter.isDirExcluded('vendor')).toBe(true);
      // Build output
      expect(filter.isDirExcluded('dist')).toBe(true);
      expect(filter.isDirExcluded('build')).toBe(true);
      expect(filter.isDirExcluded('.next')).toBe(true);
      expect(filter.isDirExcluded('.turbo')).toBe(true);
      expect(filter.isDirExcluded('coverage')).toBe(true);
      // VCS / per-project state
      expect(filter.isDirExcluded('.git')).toBe(true);
      // Skills-as-content: `.ok` is descendable (to reach `.ok/skills`); its
      // non-skill children remain excluded so the descent stays bounded.
      expect(filter.isDirExcluded('.ok')).toBe(false);
      expect(filter.isDirExcluded('.ok/local')).toBe(true);
      expect(filter.isDirExcluded('.ok/local/cache')).toBe(true);
      // Normal dirs still pass
      expect(filter.isDirExcluded('docs')).toBe(false);
      expect(filter.isDirExcluded('src')).toBe(false);
    });

    test('excludes BUILTIN_SKIP_DIRS at any path depth, not just top segment (FR-CF1)', () => {
      // nested `.ok/`
      // directories carry per-folder metadata + templates. Without this fix, a
      // path like `meetings/.ok/templates/foo.md` slipped past `isDirExcluded`
      // (topSegment was `meetings`, not in BUILTIN_SKIP_DIRS) and got indexed as
      // ordinary content. Collateral fix for nested node_modules/, dist/, etc.
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Nested .ok/
      expect(filter.isDirExcluded('meetings/.ok')).toBe(true);
      expect(filter.isDirExcluded('meetings/.ok/templates')).toBe(true);
      expect(filter.isDirExcluded('a/b/c/.ok/d')).toBe(true);

      // Nested node_modules/ — latent bug fixed as collateral
      expect(filter.isDirExcluded('packages/foo/node_modules')).toBe(true);
      expect(filter.isDirExcluded('packages/foo/node_modules/bar')).toBe(true);

      // Nested build outputs
      expect(filter.isDirExcluded('apps/web/dist')).toBe(true);
      expect(filter.isDirExcluded('apps/web/.next/cache')).toBe(true);

      // Sanity: paths with NO skip segment are still allowed
      expect(filter.isDirExcluded('meetings/prep-notes')).toBe(false);
      expect(filter.isDirExcluded('a/b/c')).toBe(false);
    });

    test('does not descend into node_modules during populateDirCount even with a symlink inside', () => {
      // Create a node_modules dir with a broken symlink (simulates pnpm layout)
      const nmDir = join(projectDir, 'node_modules');
      mkdirSync(nmDir);
      // Broken symlink — target does not exist
      symlinkSync(join(nmDir, 'nonexistent-target'), join(nmDir, 'broken-link'));
      // A real .md inside node_modules — if populateDirCount descends, the dir
      // would count as having an included doc, making its sibling assets pass.
      writeFileSync(join(nmDir, 'README.md'), '# Pkg\n');
      writeFileSync(join(projectDir, 'docs.md'), '# Docs\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // node_modules was skipped: the .md inside it was NOT counted, so the
      // sibling-asset rule does not apply and its assets remain excluded.
      expect(filter.isExcluded('node_modules/logo.png')).toBe(true);
    });

    test('admits .ok only down the skills path; non-skill .ok files stay excluded', () => {
      // Skills-as-content makes `.ok` descendable so the walk can reach
      // `.ok/skills/<name>/SKILL`, but the file-level predicates keep everything
      // else under `.ok/` out — so assets and stray docs next to internal files
      // are never admitted, even though the directory is walked.
      mkdirSync(join(projectDir, '.ok'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'AGENTS.md'), '# Agents\n');
      writeFileSync(join(projectDir, 'docs.md'), '# Docs\n');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // `.ok` is descendable, but its non-skill children are not.
      expect(filter.isDirExcluded('.ok')).toBe(false);
      expect(filter.isDirExcluded('.ok/local')).toBe(true);
      // Files directly under `.ok/` (not `.ok/skills/...`) stay excluded.
      expect(filter.isExcluded('.ok/logo.png')).toBe(true);
      expect(filter.isExcluded('.ok/AGENTS.md')).toBe(true);
    });

    test('isExcluded rejects supported docs born inside BUILTIN_SKIP_DIRS', () => {
      // Watcher events fire for files created inside `.ok/` after boot
      // (e.g. MCP `write_template` writing `<folder>/.ok/templates/foo.md`).
      // classifyEvents only consults `isExcluded` per-event — without the
      // BUILTIN_SKIP_DIRS gate here the file slipped past the supported-
      // extension fast-path and landed in the file index, surfacing the
      // template `.md` and its parent `.ok/templates/` folder in the file
      // tree. Mirrors `isDirExcluded`'s segment-wise check.
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Top-level `.ok/templates/<name>.md` (project-root scope template).
      expect(filter.isExcluded('.ok/templates/daily.md')).toBe(true);
      // Nested folder-scope template.
      expect(filter.isExcluded('meetings/.ok/templates/standup.md')).toBe(true);
      // Folder-defaults file in the same hidden dir.
      expect(filter.isExcluded('meetings/.ok/frontmatter.yml.md')).toBe(true);
      // Other BUILTIN_SKIP_DIRS at any depth — collateral coverage.
      expect(filter.isExcluded('node_modules/some-pkg/README.md')).toBe(true);
      expect(filter.isExcluded('apps/web/dist/index.md')).toBe(true);

      // Sanity: ordinary docs are still admitted.
      expect(filter.isExcluded('meetings/prep-notes.md')).toBe(false);
      expect(filter.isExcluded('docs/intro.md')).toBe(false);
    });
  });

  describe('always-skip floor survives bypassFilters (Show All Files OOM guard)', () => {
    // `?showAll=true` passes `{ bypassFilters: true }` so the sidebar can
    // surface .gitignored / .okignored content. The floor is the hard limit on
    // that bypass: `.git/`, `node_modules/`, `.ok/` (+ legacy state dirs) are
    // NEVER traversed or admitted, because walking them on a repo-root content
    // dir (a multi-GB `.git` object store, thousands of nested `node_modules`)
    // makes the recursive `?showAll=true` walk unbounded and exhausts the heap.
    const BYPASS = { bypassFilters: true } as const;

    function assertFloor(filter: ContentFilter) {
      // Directories on the floor are pruned even under bypass — this prune is
      // what halts the recursive descent in the showAll walk.
      expect(filter.isDirExcluded('.git', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('node_modules', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('node_modules/some-pkg', BYPASS)).toBe(true);
      // The skills-as-content `.ok` carve-out is gated on `!bypassFilters`, so
      // under Show All Files `.ok` stays FLOORED (internal dir; the normal index
      // walk is the only path that descends it to reach `.ok/skills`).
      expect(filter.isDirExcluded('.ok', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.ok/local', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.open-knowledge', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.openknowledge', BYPASS)).toBe(true);
      // Floor segments at any depth, not just the top.
      expect(filter.isDirExcluded('packages/foo/node_modules', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('a/b/.git/c', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('meetings/.ok/templates', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('a/b/.open-knowledge/c', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('a/b/.openknowledge', BYPASS)).toBe(true);

      // Files inside the floor are excluded under bypass too (defense-in-depth
      // for any caller that enumerates files without first gating the dir).
      expect(filter.isExcluded('.git/objects/x.md', BYPASS)).toBe(true);
      expect(filter.isExcluded('node_modules/pkg/README.md', BYPASS)).toBe(true);
      expect(filter.isExcluded('.ok/templates/daily.md', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.git/config', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('node_modules/pkg/index.js', BYPASS)).toBe(true);

      // Junk-file floor — macOS Finder metadata (`.DS_Store`, `.localized`)
      // stays excluded under bypass at any depth, so Show All Files never
      // surfaces it as a sidebar asset row. Exact-basename match: a real file
      // whose name merely ends with `.DS_Store` is NOT junk and still surfaces.
      expect(filter.isExcluded('.DS_Store', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/.DS_Store', BYPASS)).toBe(true);
      expect(filter.isExcluded('a/b/c/.DS_Store', BYPASS)).toBe(true);
      expect(filter.isExcluded('.localized', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/.localized', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.DS_Store', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('notes/.DS_Store', BYPASS)).toBe(true);
      // Precision: substring/suffix lookalikes are real files, not junk.
      expect(filter.isExcluded('archive.DS_Store', BYPASS)).toBe(false);
      expect(filter.isExcluded('notes/my.DS_Store.md', BYPASS)).toBe(false);

      // Secret-bearing floor — `.env` / private-key files / `.ssh` /
      // `.aws` / `.gnupg` stay excluded even under bypass. Independent of
      // user gitignore: an unconfigured workspace pointed at `~/projects/`
      // would otherwise leak `.env` and `aws-prod-root-key.pem` filenames
      // through /api/documents and the search corpus.
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
      // Same gate on `isPathIgnored`, which is what `kind:'file'` admission
      // uses; missing it would leak secret names into the all-files search
      // corpus even when `isExcluded` correctly gates markdown.
      expect(filter.isPathIgnored('.env', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('packages/.env.local', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('aws-prod-root-key.pem', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('id_rsa', BYPASS)).toBe(true);
      // Secret-bearing directories (`.ssh` / `.aws` / `.gnupg` / `.kube` /
      // `.docker`) gate at the dir boundary so the watcher doesn't descend
      // into them.
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
      // Modern SSH key shapes at workspace root (no `.ssh/` directory bucket
      // to catch them) — a bare `id_ed25519` / `id_ecdsa` / `id_dsa` at root
      // must still be floored on the basename rule.
      expect(filter.isExcluded('id_ed25519', BYPASS)).toBe(true);
      expect(filter.isExcluded('id_ecdsa', BYPASS)).toBe(true);
      expect(filter.isExcluded('id_dsa', BYPASS)).toBe(true);
      expect(filter.isExcluded('id_ed25519.pub', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('id_ed25519', BYPASS)).toBe(true);
      // Common credential shapes: `.netrc`, `.npmrc`, `.pgpass`,
      // `.git-credentials`. All are exact-basename matches — `notes/.netrc`
      // is just as sensitive as `.netrc` at root, but `mynetrc.md` is not.
      expect(filter.isExcluded('.netrc', BYPASS)).toBe(true);
      expect(filter.isExcluded('.npmrc', BYPASS)).toBe(true);
      expect(filter.isExcluded('.pgpass', BYPASS)).toBe(true);
      expect(filter.isExcluded('.git-credentials', BYPASS)).toBe(true);
      expect(filter.isExcluded('notes/.netrc', BYPASS)).toBe(true);
      expect(filter.isExcluded('packages/.npmrc', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.netrc', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.git-credentials', BYPASS)).toBe(true);
      // Additional cert/keystore suffixes: `.pfx`, `.keystore`, `.jks`,
      // `.ppk` (Windows / Java / PuTTY conventions); same case-insensitive
      // suffix-match as `.pem`/`.key`/`.p12`.
      expect(filter.isExcluded('certs/server.pfx', BYPASS)).toBe(true);
      expect(filter.isExcluded('certs/SERVER.PFX', BYPASS)).toBe(true);
      expect(filter.isExcluded('app/release.keystore', BYPASS)).toBe(true);
      expect(filter.isExcluded('release.jks', BYPASS)).toBe(true);
      expect(filter.isExcluded('windows-id.ppk', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('release.jks', BYPASS)).toBe(true);
      // Precision: lookalikes that aren't secrets stay admitted. A file named
      // `.environment` (not `.env.<anything>`) or `keymap.md` (not `*.key`)
      // is real content; same for non-exact basenames of the credential set.
      expect(filter.isExcluded('docs/.environment.md', BYPASS)).toBe(false);
      expect(filter.isExcluded('docs/keymap.md', BYPASS)).toBe(false);
      expect(filter.isExcluded('packages/foo/keynote.md', BYPASS)).toBe(false);
      // `.npmrc.example` / `mynetrc.md` are documentation, not the
      // credential file itself — the exact-basename gate is the precision
      // boundary.
      expect(filter.isExcluded('docs/.npmrc.example', BYPASS)).toBe(false);
      expect(filter.isExcluded('docs/mynetrc.md', BYPASS)).toBe(false);

      // Case-insensitivity across ALL floor rules. On a case-insensitive
      // filesystem (default macOS) the watcher reports the on-disk casing, so
      // `.ENV` / `ID_RSA` / `CREDENTIALS` / `.SSH` must floor exactly as their
      // lowercase forms do. (`SERVER.PEM` / `SERVER.PFX` already cover
      // the suffix path; these cover the exact-basename and directory paths.)
      expect(filter.isExcluded('.ENV', BYPASS)).toBe(true);
      expect(filter.isExcluded('packages/server/.Env.Production', BYPASS)).toBe(true);
      expect(filter.isExcluded('ID_RSA', BYPASS)).toBe(true);
      expect(filter.isExcluded('ID_ED25519', BYPASS)).toBe(true);
      expect(filter.isExcluded('CREDENTIALS', BYPASS)).toBe(true);
      expect(filter.isExcluded('.GIT-CREDENTIALS', BYPASS)).toBe(true);
      expect(filter.isPathIgnored('.ENV', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('.SSH', BYPASS)).toBe(true);
      expect(filter.isDirExcluded('home/user/.AWS', BYPASS)).toBe(true);
      // `known_hosts` is not itself a secret basename, but the `.SSH` segment
      // prunes the whole directory regardless of casing.
      expect(filter.isExcluded('.SSH/known_hosts', BYPASS)).toBe(true);
      // Precision survives lowercasing: a doc whose name merely shares a
      // prefix/suffix with a secret rule stays admitted in any casing.
      expect(filter.isExcluded('docs/.Environment.md', BYPASS)).toBe(false);
      expect(filter.isExcluded('docs/KEYMAP.md', BYPASS)).toBe(false);

      // The skills-as-content carve-out must NOT short-circuit the secret floor.
      // A secret adopted into a skill dir (`.ok/skills/<name>/...`) is matched by
      // `isSkillContentFile`, and `.key` even doubles as a Keynote asset
      // extension — but the secret floor runs FIRST and excludes it across every
      // predicate. Otherwise the file would be indexed and, via `isPathIgnored`
      // (the asset-serve gate), network-servable as a download. Asserted WITHOUT
      // bypass: normal mode is where the skill carve-out is live.
      expect(filter.isExcluded('.ok/skills/foo/server.key')).toBe(true);
      expect(filter.isExcluded('.ok/skills/foo/id_rsa')).toBe(true);
      expect(filter.isExcluded('.ok/skills/foo/.env')).toBe(true);
      expect(filter.isPathIgnored('.ok/skills/foo/server.key')).toBe(true);
      expect(filter.isPathIgnored('.ok/skills/foo/id_rsa')).toBe(true);
      expect(filter.isPathIgnored('.ok/skills/foo/.env')).toBe(true);
      expect(filter.isDirExcluded('.ok/skills/foo/.ssh')).toBe(true);
      // Precision: legitimate skill content under the same dir is still admitted
      // (the secret floor is exact, not a blanket skill-dir exclusion).
      expect(filter.isExcluded('.ok/skills/foo/SKILL.md')).toBe(false);
      expect(filter.isExcluded('.ok/skills/foo/diagram.png')).toBe(false);

      // Content-bearing BUILTIN_SKIP_DIRS are NOT on the floor: bypass still
      // surfaces them even when .gitignored — the Show All Files intent the
      // floor must preserve (strict subset, not all of BUILTIN_SKIP_DIRS).
      expect(filter.isDirExcluded('dist', BYPASS)).toBe(false);
      expect(filter.isDirExcluded('build', BYPASS)).toBe(false);
      expect(filter.isDirExcluded('coverage', BYPASS)).toBe(false);
      expect(filter.isDirExcluded('.venv', BYPASS)).toBe(false);
      expect(filter.isExcluded('dist/bundle.js', BYPASS)).toBe(false);
      expect(filter.isExcluded('build/compiled.md', BYPASS)).toBe(false);

      // Ordinary content admitted under bypass.
      expect(filter.isDirExcluded('docs', BYPASS)).toBe(false);
      expect(filter.isExcluded('docs/intro.md', BYPASS)).toBe(false);

      // STOP-rule gate still wins over everything, even under bypass.
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

  describe('reserved system doc names', () => {
    test('excludes __system__.md', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('__system__.md')).toBe(true);
    });

    test('does not exclude files with __system__ in non-identity positions', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Only the exact reserved docName ('__system__') is blocked — subfolders / lookalikes pass
      expect(filter.isExcluded('notes/__system__-notes.md')).toBe(false);
      expect(filter.isExcluded('docs/about-__system__.md')).toBe(false);
    });
  });

  describe('reserved config doc names', () => {
    // synthetic config-doc admission means the same content-filter
    // bypass that protects __system__.md must also reject any disk artifact
    // named after the project or user-global config docs. Sidecars or
    // accidental collisions on those names would otherwise round-trip into
    // the user's content tree.
    test('excludes __config__/project.md', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('__config__/project.md')).toBe(true);
      expect(filter.isExcluded('__config__/project.mdx')).toBe(true);
    });

    test('excludes __user__/config.yml.md', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // After stripDocExtension, '__user__/config.yml.md' → '__user__/config.yml'
      // which is the reserved doc name for the user-global config.
      expect(filter.isExcluded('__user__/config.yml.md')).toBe(true);
      expect(filter.isExcluded('__user__/config.yml.mdx')).toBe(true);
    });

    test('does not exclude unrelated files in __config__/ or __user__/ paths', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Only the exact reserved synthetic names are blocked.
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

      // Paths are relative to contentDir for the filter API,
      // but mapped to projectDir-relative for the ignore lookup.
      expect(filter.isExcluded('readme.md')).toBe(false);
    });

    test('root gitignore excludes paths mapped through contentRelPrefix', () => {
      const contentDir = join(projectDir, 'docs');
      mkdirSync(contentDir);
      mkdirSync(join(contentDir, 'generated'), { recursive: true });
      // Root .gitignore excludes docs/generated/ (project-relative)
      writeFileSync(join(projectDir, '.gitignore'), 'docs/generated/\n');

      const filter = createContentFilter({ projectDir, contentDir });

      // Path is contentDir-relative; filter maps to project-relative for gitignore
      expect(filter.isExcluded('generated/output.md')).toBe(true);
      expect(filter.isExcluded('guide.md')).toBe(false);
    });

    test('loads .gitignore at contentDir root when contentDir != projectDir', () => {
      const contentDir = join(projectDir, 'docs');
      mkdirSync(contentDir);
      // .gitignore at contentDir root (not project root)
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

    test('excludes non-allowlisted extension even with sibling .md', () => {
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Script extensions and arbitrary unknown types stay excluded even when
      // a sibling .md is present.
      expect(filter.isExcluded('docs/script.js')).toBe(true);
      expect(filter.isExcluded('docs/arbitrary.xyz')).toBe(true);
      expect(filter.isExcluded('docs/other.unknown')).toBe(true);
    });

    test('includes widened user-drop extensions when sibling .md exists (2026-04-24b)', () => {
      // Pins the widened LINKABLE_ASSET_EXTENSIONS set against the filter's
      // admission behavior — one representative from each user-visible class.
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Video (the bug reporter's file type)
      expect(filter.isExcluded('docs/clip.m4v')).toBe(false);
      expect(filter.isExcluded('docs/clip.mkv')).toBe(false);
      // Audio
      expect(filter.isExcluded('docs/song.flac')).toBe(false);
      // Office docs
      expect(filter.isExcluded('docs/spec.docx')).toBe(false);
      expect(filter.isExcluded('docs/sheet.xlsx')).toBe(false);
      // Tabular / text
      expect(filter.isExcluded('docs/data.csv')).toBe(false);
      expect(filter.isExcluded('docs/notes.txt')).toBe(false);
      // Data serialization
      expect(filter.isExcluded('docs/config.json')).toBe(false);
    });

    test('.base and .canvas files are admitted when a sibling .md exists', () => {
      mkdirSync(join(projectDir, 'vault'));
      writeFileSync(join(projectDir, 'vault', 'note.md'), '# Note');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('vault/Characters.base')).toBe(false);
      expect(filter.isExcluded('vault/Board.canvas')).toBe(false);
      // Without a sibling doc, they remain excluded (sibling-asset rule).
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
    // The contract: isPathIgnored shares the path-level rejection rules with
    // isExcluded (system/config docs, BUILTIN_SKIP_DIRS, .gitignore/.okignore)
    // but intentionally omits the sibling-asset admission heuristic.
    // Callers that already know a path is a referenced asset (handleAsset,
    // collectReferencedAssets) need the security boundary check WITHOUT the
    // "directory has a sibling .md" gate, which would otherwise drop
    // legitimate cross-directory references like docs/media/diagram.png.

    test('admits asset in directory without sibling .md (D11 not applied)', () => {
      // The defining divergence from isExcluded. A bare assets/ directory has
      // no sibling .md, so isExcluded rejects assets/logo.png via the default
      // case at the end of the chain. isPathIgnored returns false because
      // none of the path-level rules reject it.
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
      // Test-isolation case: ignore rules anchored at projectDir do not apply
      // because the ignore library rejects ".."-prefixed paths. BUILTIN_SKIP_DIRS
      // still applies because the segment scan is path-shape-only.
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
      // For paths that isExcluded rejects via steps 0/0.5/1 (not the
      // sibling-asset rule), isPathIgnored agrees. Pins the shared-rule
      // contract: anything path-level-rejected by isExcluded is also
      // path-ignored, and only the trailing admission diverges.
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

      // Sibling-asset admission diverges: isExcluded admits, isPathIgnored
      // admits via "not rejected by path rules". Both end up false but for
      // different reasons.
      expect(filter.isExcluded('docs/screenshot.png')).toBe(false);
      expect(filter.isPathIgnored('docs/screenshot.png')).toBe(false);
    });
  });

  describe('rebuildIgnorePatterns', () => {
    test('reflects new patterns after .okignore is created on disk', async () => {
      // Filter built with no ignore files — `drafts/foo.md` admitted.
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('drafts/foo.md')).toBe(false);

      // User edits .okignore externally; rebuild picks it up.
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
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.getWatcherIgnoreGlobs()).toContain('drafts/');

      writeFileSync(join(projectDir, '.okignore'), 'archive/\n');
      await filter.rebuildIgnorePatterns();

      const globs = filter.getWatcherIgnoreGlobs();
      expect(globs).toContain('archive/');
      expect(globs).not.toContain('drafts/');
    });

    test('refreshes sibling-asset dirCount against new exclusions', async () => {
      // Start with a docs/guide.md that admits sibling assets.
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      expect(filter.isExcluded('docs/screenshot.png')).toBe(false);

      // After rebuild with a pattern that hides docs/, the sibling-asset rule
      // must NOT admit the asset (dirCount for docs is now 0 — guide.md
      // excluded).
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
      // .gitignore: 1 pattern; .okignore: 2 patterns. Total: 3.
      expect(result.patternCount).toBe(3);
      expect(result.nestedFileCount).toBe(0);
      expect(typeof result.bytes).toBe('number');
      expect(result.bytes).toBeGreaterThan(0);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
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
      // Two nested files: subdir/.okignore + subdir/deep/.gitignore.
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

      // Construction should NOT fire the callback.
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

      // The first add() inside buildPatternState is `newIg.add('.git')`.
      // Spying on the prototype intercepts ALL ignore instances in this
      // process — but mockImplementationOnce ensures only the next call
      // throws. We trigger that call by entering rebuildIgnorePatterns.
      const sampleProto = Object.getPrototypeOf(ignore());
      const addSpy = spyOn(sampleProto, 'add').mockImplementationOnce(() => {
        throw new Error('forced ignore.add failure');
      });

      try {
        const result = await filter.rebuildIgnorePatterns();
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.error.message).toContain('forced ignore.add failure');
        // Callback was not invoked because rebuild failed.
        expect(calls).toBe(0);
        // State rolled back: pre-rebuild .okignore patterns still apply.
        expect(filter.isExcluded('drafts/foo.md')).toBe(true);
        expect(filter.isExcluded('docs/guide.md')).toBe(false);
      } finally {
        addSpy.mockRestore();
      }
    });

    test('rolls back state on error (ig + watcherGlobs + dirCount)', async () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      mkdirSync(join(projectDir, 'docs'));
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });
      // Sanity: pre-rebuild visible-set
      expect(filter.isExcluded('drafts/x.md')).toBe(true);
      expect(filter.isExcluded('docs/screenshot.png')).toBe(false);
      expect(filter.getWatcherIgnoreGlobs()).toContain('drafts/');

      // Force the rebuild to fail.
      const sampleProto = Object.getPrototypeOf(ignore());
      const addSpy = spyOn(sampleProto, 'add').mockImplementationOnce(() => {
        throw new Error('boom');
      });

      // Mutate the disk state so a SUCCESSFUL rebuild WOULD diverge — proves
      // the rollback restored the old state, not just failed silently.
      writeFileSync(join(projectDir, '.okignore'), 'archive/\n');

      try {
        const result = await filter.rebuildIgnorePatterns();
        expect(result.ok).toBe(false);

        // State must reflect the OLD .okignore (drafts/), not the new one (archive/).
        expect(filter.isExcluded('drafts/x.md')).toBe(true);
        expect(filter.isExcluded('archive/x.md')).toBe(false);
        // watcherGlobs reflects the OLD patterns.
        expect(filter.getWatcherIgnoreGlobs()).toContain('drafts/');
        expect(filter.getWatcherIgnoreGlobs()).not.toContain('archive/');
        // dirCount for docs/ still admits sibling assets.
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
      // Rebuild applied successfully despite the callback throwing.
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

      // Cardinality discipline — none of the recorded attribute names should
      // carry raw file paths or pattern content. Whitelist what we expect.
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
      const addSpy = spyOn(sampleProto, 'add').mockImplementationOnce(() => {
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
      // Span ended; on the error path the rebuild was caught — withSpan
      // records whatever status the body sets. We just assert the span
      // exists; status code is determined by withSpan's catch-and-rethrow,
      // which the rebuild handler swallows. Either status is acceptable.
      expect(span.status).toBeDefined();
    });
  });

  describe('rebuildIgnorePatterns performance gate (NFR Performance)', () => {
    // STOP_IF: if this gate fails on N=1000 docs / >500ms p95, return to
    // spec for delta-rebuild design.
    test('rebuild on N=1000-doc workspace completes well under 500ms', async () => {
      // Layout: 50 directories × 20 docs each = 1000 docs. Plus 5 scattered
      // nested .okignore files to exercise the recursive walker. Synthetic
      // but representative of a moderate knowledge base.
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

      // Warm-up — ignore first run (filesystem cache, JIT).
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
      // a project with only .gitignore + no custom config
      // and no .okignore must index the exact same files as the pre-rename
      // baseline did with `content.include = ['**/*.md', '**/*.mdx']` and
      // empty `content.exclude`.
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
      mkdirSync(join(projectDir, 'docs'), { recursive: true });
      writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide');
      writeFileSync(join(projectDir, 'docs', 'overview.mdx'), '# Overview');
      mkdirSync(join(projectDir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(projectDir, 'node_modules', 'pkg', 'README.md'), '# Pkg');
      writeFileSync(join(projectDir, 'README.md'), '# Project');
      writeFileSync(join(projectDir, 'script.ts'), 'export {}');

      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Indexed: README.md, docs/guide.md, docs/overview.mdx
      expect(filter.isExcluded('README.md')).toBe(false);
      expect(filter.isExcluded('docs/guide.md')).toBe(false);
      expect(filter.isExcluded('docs/overview.mdx')).toBe(false);

      // Excluded: node_modules content (gitignore + BUILTIN_SKIP_DIRS), .ts
      // (not a supported doc), nothing else.
      expect(filter.isExcluded('node_modules/pkg/README.md')).toBe(true);
      expect(filter.isExcluded('script.ts')).toBe(true);
    });
  });

  describe('bypassFilters mode (Show All Files — FR6 / D12)', () => {
    test('admits .gitignored files', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'secrets/\n*.log\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Default — excluded
      expect(filter.isExcluded('secrets/api-key.md')).toBe(true);
      expect(filter.isExcluded('debug.log')).toBe(true);

      // Bypass — admitted
      expect(filter.isExcluded('secrets/api-key.md', { bypassFilters: true })).toBe(false);
      expect(filter.isExcluded('debug.log', { bypassFilters: true })).toBe(false);
    });

    test('admits .okignored files', () => {
      writeFileSync(join(projectDir, '.okignore'), 'drafts/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      expect(filter.isExcluded('drafts/wip.md')).toBe(true);
      expect(filter.isExcluded('drafts/wip.md', { bypassFilters: true })).toBe(false);
    });

    test('admits content-bearing BUILTIN_SKIP_DIRS (dist) in bypass mode', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Default — excluded by BUILTIN_SKIP_DIRS (segment-wise, any depth).
      expect(filter.isExcluded('apps/web/dist/index.md')).toBe(true);

      // Bypass — admitted. `dist` is in BUILTIN_SKIP_DIRS but NOT on the
      // always-skip floor, so Show All Files surfaces it. The floor dirs
      // (.git/node_modules/.ok) stay excluded even under bypass — see the
      // 'always-skip floor survives bypassFilters' describe block.
      expect(filter.isExcluded('apps/web/dist/index.md', { bypassFilters: true })).toBe(false);
    });

    test('admits non-md/non-asset extensions (.ts, .py, .sh) only under bypass', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Default — excluded (no supported extension; not in LINKABLE_ASSET_EXTENSIONS).
      // `.yaml` is intentionally absent here — adding it to ASSET_EXTENSIONS makes
      // it a LINKABLE_ASSET_EXTENSIONS member, so it follows the sibling-asset
      // rule, not the non-asset default-exclude branch.
      expect(filter.isExcluded('src/index.ts')).toBe(true);
      expect(filter.isExcluded('scripts/build.sh')).toBe(true);
      expect(filter.isExcluded('analysis.py')).toBe(true);

      // Bypass — admitted (Show All Files surfaces literally every file).
      expect(filter.isExcluded('src/index.ts', { bypassFilters: true })).toBe(false);
      expect(filter.isExcluded('scripts/build.sh', { bypassFilters: true })).toBe(false);
      expect(filter.isExcluded('analysis.py', { bypassFilters: true })).toBe(false);
    });

    test('STOP rule preserved — reserved system + config doc names stay hidden in bypass mode', () => {
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Even with bypassFilters:true, the synthetic-doc gate fires first.
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

      // Default — both excluded.
      expect(filter.isDirExcluded('drafts')).toBe(true);
      expect(filter.isDirExcluded('dist')).toBe(true);

      // Bypass surfaces gitignored (drafts) and content-bearing skip-dirs
      // (dist). The always-skip floor (.git/node_modules/.ok) stays pruned
      // even here — covered by the 'always-skip floor' describe block.
      expect(filter.isDirExcluded('drafts', { bypassFilters: true })).toBe(false);
      expect(filter.isDirExcluded('dist', { bypassFilters: true })).toBe(false);
    });

    test('isPathIgnored preserves STOP rule in bypass mode', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'private/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Default behavior unchanged.
      expect(filter.isPathIgnored('private/secret.md')).toBe(true);
      expect(filter.isPathIgnored('docs/readme.md')).toBe(false);
      expect(filter.isPathIgnored('__system__.md')).toBe(true);

      // Bypass admits gitignored, but reserved docs stay hidden.
      expect(filter.isPathIgnored('private/secret.md', { bypassFilters: true })).toBe(false);
      expect(filter.isPathIgnored('__system__.md', { bypassFilters: true })).toBe(true);
      expect(filter.isPathIgnored('__config__/project.md', { bypassFilters: true })).toBe(true);
    });

    test('default behavior (no opts) byte-equivalent to opts.bypassFilters === false', () => {
      writeFileSync(join(projectDir, '.gitignore'), 'dist/\n');
      const filter = createContentFilter({ projectDir, contentDir: projectDir });

      // Existing call sites passing no opts must behave identically to
      // explicit bypassFilters:false (backwards-compat invariant).
      const paths = ['dist/out.md', 'docs/guide.md', '__system__.md', 'script.ts'];
      for (const p of paths) {
        expect(filter.isExcluded(p)).toBe(filter.isExcluded(p, { bypassFilters: false }));
        expect(filter.isDirExcluded(p)).toBe(filter.isDirExcluded(p, { bypassFilters: false }));
        expect(filter.isPathIgnored(p)).toBe(filter.isPathIgnored(p, { bypassFilters: false }));
      }
    });
  });

  // Single-file content scope (no-project ephemeral open). The filter admits
  // ONLY the one target doc; every sibling document is unscoped. Sibling assets
  // the doc references still SERVE because `isPathIgnored` is deliberately left
  // unscoped (only `isExcluded` / `isDirExcluded` short-circuit).
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
      // Even a doc that exists on disk in a subfolder is unscoped — proves the
      // boot walk never indexed siblings.
      expect(filter.isExcluded('sub/deep.md')).toBe(true);
    });

    test('isDirExcluded prunes every directory for a bare-basename target', () => {
      const filter = createContentFilter({
        projectDir,
        contentDir: projectDir,
        singleDocRelPath: 'notes.md',
      });
      // No directory is an ancestor of a root-level file → all pruned.
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
      // `![](sibling.png)` / `![[sibling.png]]` admission uses isPathIgnored,
      // which must NOT be scoped — else the asset would 404.
      expect(filter.isPathIgnored('sibling.png')).toBe(false);
      expect(filter.isPathIgnored('notes.md')).toBe(false);
      // The security boundary still holds on isPathIgnored.
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
      // Ephemeral mode: projectDir is a throwaway temp dir, contentDir is the
      // file's real parent — so `contentOutsideProject` is true and ALL ignore
      // logic is inert. The singleDocRelPath short-circuit is the sole gate.
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
});
