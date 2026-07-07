import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALL_EDITOR_IDS } from '@inkeep/open-knowledge-core';
import {
  CreateNewProjectError,
  folderState,
  type RunCreateNewDeps,
  resolveDefaultProjectsRoot,
  runCreateNew,
  sanitizeFolderName,
} from './create-new-project.ts';
import {
  type DiscoverProjectOptions,
  type DiscoverProjectResult,
  discoverProject,
} from './folder-admission.ts';

/**
 * Pure-function coverage of the create-new-project cascade helpers + an
 * end-to-end pin of `runCreateNew` against `mkdtempSync` trees. The handler
 * does real `git init` via `ensureProjectGit`, so these tests need a real
 * filesystem AND a working `git` binary on PATH — same precondition the
 * onboarding-consent integration suite relies on.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ok-create-new-'));
});

afterEach(() => {
  // Restore writability before rmSync — some tests chmod 0o555 to force
  // EACCES on mkdir, which would otherwise leave the tree unremovable.
  try {
    chmodSync(tmpRoot, 0o755);
  } catch {
    // Best-effort; rmSync still tries with force: true.
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('sanitizeFolderName', () => {
  test('strips path separators and reserved chars', () => {
    expect(sanitizeFolderName('My/Notes')).toBe('My-Notes');
    expect(sanitizeFolderName('a:b*c?')).toBe('a-b-c');
    expect(sanitizeFolderName('foo<bar>')).toBe('foo-bar');
  });

  test('trims leading and trailing dashes / dots / whitespace', () => {
    expect(sanitizeFolderName('  My Notes  ')).toBe('My Notes');
    expect(sanitizeFolderName('---name---')).toBe('name');
    expect(sanitizeFolderName('...name...')).toBe('name');
  });

  test('returns empty for nothing-but-separators', () => {
    expect(sanitizeFolderName('////')).toBe('');
    expect(sanitizeFolderName('   ')).toBe('');
  });

  test('preserves normal names unchanged', () => {
    expect(sanitizeFolderName('My Notes')).toBe('My Notes');
    expect(sanitizeFolderName('project-2026')).toBe('project-2026');
  });
});

describe('folderState', () => {
  test("returns 'free' when the path does not exist", () => {
    expect(folderState(join(tmpRoot, 'absent'))).toBe('free');
  });

  test("returns 'exists-empty' for an empty directory", () => {
    const dir = join(tmpRoot, 'empty');
    mkdirSync(dir);
    expect(folderState(dir)).toBe('exists-empty');
  });

  test("returns 'exists-nonempty' for a directory with entries", () => {
    const dir = join(tmpRoot, 'nonempty');
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), 'hi');
    expect(folderState(dir)).toBe('exists-nonempty');
  });

  test("treats a regular file at the path as 'exists-nonempty'", () => {
    const f = join(tmpRoot, 'a-file');
    writeFileSync(f, 'hi');
    expect(folderState(f)).toBe('exists-nonempty');
  });
});

describe('CreateNewProjectError — IPC-parseable message format', () => {
  // Electron strips Error subclass identity at the IPC boundary; the renderer
  // sees only `.message`. `parseCreateNewError` recovers the structured reason
  // by prefix-matching `<reason>:` in the message text, so the constructor
  // MUST embed the reason in the message itself.
  test('message prepends reason so a string-prefix match recovers it', () => {
    const err = new CreateNewProjectError('nested-project', 'detail goes here');
    expect(err.message).toBe('nested-project: detail goes here');
  });

  test('reason prefix survives every documented failure reason', () => {
    const reasons = [
      'invalid-args',
      'nested-project',
      'target-not-empty',
      'mkdir-failed',
      'git-init-failed',
      'init-failed',
      'discovery-failed',
    ] as const;
    for (const reason of reasons) {
      const err = new CreateNewProjectError(reason, 'x');
      expect(err.message.startsWith(`${reason}:`)).toBe(true);
    }
  });
});

describe('resolveDefaultProjectsRoot', () => {
  test('falls back to <documents>/OpenKnowledge on first call', () => {
    const got = resolveDefaultProjectsRoot(null, '/Users/alice/Documents');
    expect(got).toBe('/Users/alice/Documents/OpenKnowledge');
  });

  test('returns the persisted parent when it still exists', () => {
    const persisted = join(tmpRoot, 'Notes');
    mkdirSync(persisted);
    expect(resolveDefaultProjectsRoot(persisted, '/Users/alice/Documents')).toBe(persisted);
  });

  test('falls back when the persisted parent no longer exists', () => {
    const persisted = join(tmpRoot, 'deleted');
    expect(resolveDefaultProjectsRoot(persisted, '/Users/alice/Documents')).toBe(
      '/Users/alice/Documents/OpenKnowledge',
    );
  });

  test('absorbs throwing exists-checks', () => {
    const persisted = join(tmpRoot, 'irrelevant');
    const got = resolveDefaultProjectsRoot(persisted, '/Users/alice/Documents', () => {
      throw new Error('boom');
    });
    expect(got).toBe('/Users/alice/Documents/OpenKnowledge');
  });
});

/**
 * Build a `discoverProject` stub for the DI seam. The stub forwards to the
 * real `discoverProject` (so all the realpath / mkdir / symlink semantics
 * stay honest) but injects a fixed `homeDir` AND a deterministic
 * `gitTopLevel` lookup so the test doesn't depend on whether the macOS
 * `tmpdir()` happens to sit inside (or above) the agent's `$HOME`. The real
 * `discoverProject` only promotes when `gitRoot` sits strictly below
 * `homeDir`, so tests need to point both at the same fake-home root.
 */
const makeDiscoverDeps = (
  fakeHome: string,
  gitTopLevelByCwd: Record<string, string | null>,
): RunCreateNewDeps => ({
  discoverProject: (pickedPath: string, _opts: DiscoverProjectOptions) =>
    discoverProject(pickedPath, {
      homeDir: fakeHome,
      gitTopLevel: async (cwd) => gitTopLevelByCwd[cwd] ?? null,
      dirSizeProbe: null,
    }),
});

describe('runCreateNew — happy paths', () => {
  test('scaffolds .ok/config.yml and reports default variant', async () => {
    const parent = tmpRoot;
    const result = await runCreateNew({
      parent,
      name: 'My Notes',
      editors: [...ALL_EDITOR_IDS],
    });
    expect(result.target).toBe(join(parent, 'My Notes'));
    // projectDir == realpath(target). macOS aliases /tmp → /private/tmp so
    // the realpath equality holds even though the raw strings differ.
    expect(result.projectDir).toBe(realpathSync(result.target));
    expect(result.defaultContentDir).toBe('.');
    expect(existsSync(join(result.projectDir, '.ok/config.yml'))).toBe(true);
    expect(existsSync(join(result.projectDir, '.git'))).toBe(true);
    expect(result.gitRootPromoted).toBe(false);
    expect(result.variant).toBe('create-new-default');
  });

  test('records customized variant when a subset of editors is supplied', async () => {
    const result = await runCreateNew({
      parent: tmpRoot,
      name: 'Customized',
      editors: ['codex'],
    });
    expect(result.variant).toBe('create-new-customized');
  });

  test('sanitizes path-bearing names', async () => {
    const result = await runCreateNew({
      parent: tmpRoot,
      name: 'a/b:c',
      editors: [...ALL_EDITOR_IDS],
    });
    expect(result.target).toBe(join(tmpRoot, 'a-b-c'));
  });

  test('reuses an existing empty target directory', async () => {
    const parent = tmpRoot;
    mkdirSync(join(parent, 'manual'));
    const result = await runCreateNew({
      parent,
      name: 'manual',
      editors: [...ALL_EDITOR_IDS],
    });
    expect(existsSync(join(result.projectDir, '.ok/config.yml'))).toBe(true);
  });

  test('seeds project-root .gitignore with .DS_Store on fresh git init', async () => {
    // OpenKnowledge is macOS-only today, so a fresh project gets a one-line
    // .gitignore that hides Finder's per-folder metadata. The seed only runs
    // when ensureProjectGit actually ran `git init` — confirmed in this case
    // by the absence of `.git/` before the call. See also the git-root-
    // promotion case below, which exercises the skip path.
    const result = await runCreateNew({
      parent: tmpRoot,
      name: 'Fresh',
      editors: [...ALL_EDITOR_IDS],
    });
    const gitignorePath = join(result.projectDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, 'utf8')).toContain('.DS_Store');
  });
});

describe('runCreateNew — git-root promotion', () => {
  /**
   * When the user picks a parent inside an existing git working tree, the
   * project's `.ok/config.yml` lands at the git ROOT (one `.ok/` per repo),
   * with `content.dir` defaulting to `.` (the git root). The user-facing
   * folder is still mkdir'd at `target` so it shows up in Finder, but the
   * opened folder and the content scope align by default — narrowing back
   * to the picked sub-folder is opt-in via post-init `config.yml`.
   */
  test('scaffolds .ok/config.yml at git root; content.dir defaults to the git root, not the picked sub-folder', async () => {
    // Fixture: <tmp>/home/repo/.git, <tmp>/home/repo/notes/  (parent), name 'MyProj'.
    // Use realpath on tmpRoot because macOS aliases /tmp → /private/tmp — the
    // real discoverProject realpaths everything, so fixtures must match.
    const tmpReal = realpathSync(tmpRoot);
    const fakeHome = resolve(tmpReal, 'home');
    const repo = resolve(fakeHome, 'repo');
    const notes = resolve(repo, 'notes');
    mkdirSync(notes, { recursive: true });
    mkdirSync(resolve(repo, '.git'), { recursive: true });
    writeFileSync(resolve(repo, '.git/HEAD'), 'ref: refs/heads/main\n');

    const target = resolve(notes, 'MyProj');
    const deps = makeDiscoverDeps(fakeHome, { [target]: repo });

    const result = await runCreateNew(
      { parent: notes, name: 'MyProj', editors: [...ALL_EDITOR_IDS] },
      deps,
    );

    // The project scaffolds at the git root, not the picked subfolder.
    expect(result.projectDir).toBe(repo);
    expect(result.target).toBe(target);
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(true);
    expect(result.variant).toBe('create-new-default');

    // Disk shape: .ok/config.yml at repo root only — NOT at target.
    expect(existsSync(resolve(repo, '.ok/config.yml'))).toBe(true);
    expect(existsSync(resolve(target, '.ok/config.yml'))).toBe(false);

    // The user-facing folder still exists (mkdir'd up front).
    expect(existsSync(target)).toBe(true);

    // content.dir is NOT scoped to the picked sub-folder. The "no content.dir
    // override" branch in buildConfigYmlContent comments the value out; assert
    // the live override is absent.
    const cfg = readFileSync(resolve(repo, '.ok/config.yml'), 'utf8');
    expect(cfg).not.toMatch(/^\s*dir:\s*notes\/MyProj/m);

    // Promotion lands on a pre-existing `.git/` (the enclosing repo).
    // ensureProjectGit reports didInit=false → seed helper does NOT run,
    // and any `.gitignore` the enclosing repo owns is left alone.
    expect(existsSync(resolve(repo, '.gitignore'))).toBe(false);
  });

  test('no promotion when parent has no enclosing git repo — projectDir === target, content.dir === "."', async () => {
    const tmpReal = realpathSync(tmpRoot);
    const fakeHome = resolve(tmpReal, 'home');
    const parent = resolve(fakeHome, 'plain');
    mkdirSync(parent, { recursive: true });

    // gitTopLevel stub returns null for the target (no enclosing repo).
    const target = resolve(parent, 'standalone');
    const deps = makeDiscoverDeps(fakeHome, { [target]: null });

    const result = await runCreateNew(
      { parent, name: 'standalone', editors: [...ALL_EDITOR_IDS] },
      deps,
    );

    expect(result.projectDir).toBe(target);
    expect(result.target).toBe(target);
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(false);
    expect(existsSync(resolve(target, '.ok/config.yml'))).toBe(true);

    const cfg = readFileSync(resolve(target, '.ok/config.yml'), 'utf8');
    // The "no content.dir override" branch in buildConfigYmlContent comments
    // the value out; assert the live override is absent.
    expect(cfg).not.toMatch(/^\s*dir:\s*\S/m);
  });

  test('throws discovery-failed when discoverProject returns rejected (symlink-escape)', async () => {
    // The defense-in-depth `discovery.kind === 'rejected'` branch fires only
    // when discoverProject refuses to admit the freshly-mkdir'd target —
    // typically because the path is a symlink escape or unreadable after the
    // mkdir. A refactor that silently drops this branch must fail this test.
    const deps: RunCreateNewDeps = {
      discoverProject: async (): Promise<DiscoverProjectResult> => ({
        kind: 'rejected',
        reason: 'symlink-escape',
      }),
    };
    try {
      await runCreateNew({ parent: tmpRoot, name: 'escaped', editors: [...ALL_EDITOR_IDS] }, deps);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('discovery-failed');
    }
  });

  test('throws discovery-failed when discoverProject itself throws', async () => {
    // Production callers never see this — discoverProject's own try/catch
    // converts EACCES / ELOOP / ENOENT into a `rejected` result. The handler's
    // catch around the call is a defensive guard for the not-yet-classified
    // case (e.g. a future discoverProject failure mode). Test ensures the
    // wrapper survives refactors.
    const deps: RunCreateNewDeps = {
      discoverProject: async () => {
        throw new Error('realpath EACCES');
      },
    };
    try {
      await runCreateNew({ parent: tmpRoot, name: 'broken', editors: [...ALL_EDITOR_IDS] }, deps);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('discovery-failed');
    }
  });

  test('race: enclosing .ok/ materializes between cascade and discovery → nested-project', async () => {
    // Stub discoverProject to return `kind: 'managed'` as if a sibling
    // process created an ancestor `.ok/config.yml` between step 2 (the
    // findEnclosingProjectRoot check) and step 5 (the discovery call).
    // The handler must surface `nested-project` after-the-fact rather than
    // silently scaffolding inside someone else's project.
    const deps: RunCreateNewDeps = {
      discoverProject: async (pickedPath: string): Promise<DiscoverProjectResult> => ({
        kind: 'managed',
        pickedPath,
        projectDir: resolve(pickedPath, '..'),
        ancestorPromoted: true,
      }),
    };

    try {
      await runCreateNew({ parent: tmpRoot, name: 'raced', editors: [...ALL_EDITOR_IDS] }, deps);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('nested-project');
    }
  });
});

describe('runCreateNew — defense-in-depth rejections', () => {
  test('rejects nested-project parents', async () => {
    // Stand up an existing project at <tmpRoot>/existing first.
    const existing = join(tmpRoot, 'existing');
    mkdirSync(join(existing, '.ok'), { recursive: true });
    writeFileSync(join(existing, '.ok', 'config.yml'), '# stub\n');
    try {
      await runCreateNew({
        parent: existing,
        name: 'nested',
        editors: [...ALL_EDITOR_IDS],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('nested-project');
    }
  });

  test('rejects when the target already has content', async () => {
    const parent = tmpRoot;
    const target = join(parent, 'occupied');
    mkdirSync(target);
    writeFileSync(join(target, 'preexisting.md'), 'hi');
    try {
      await runCreateNew({
        parent,
        name: 'occupied',
        editors: [...ALL_EDITOR_IDS],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('target-not-empty');
    }
  });

  test('rejects empty / whitespace names', async () => {
    try {
      await runCreateNew({ parent: tmpRoot, name: '   ', editors: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('invalid-args');
    }
  });

  test('rejects names that sanitize down to empty', async () => {
    try {
      await runCreateNew({ parent: tmpRoot, name: '//::', editors: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('invalid-args');
    }
  });

  test('rejects unknown editor ids', async () => {
    try {
      await runCreateNew({
        parent: tmpRoot,
        name: 'bad-editor',
        editors: ['not-a-real-editor'],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('invalid-args');
    }
  });

  test('path traversal in name is neutralized — target stays inside parent', async () => {
    // End-to-end pin of the handler-level traversal defense: sanitizeFolderName
    // strips path separators BEFORE `resolve(parent, sanitized)`, so a name
    // like '../../escape' cannot walk outside the parent tree. The sanitizer
    // is unit-tested in isolation; this test pins the pipeline so a future
    // sanitizer-regex weakening or a refactor that drops the sanitize step
    // before resolve() can't silently bypass the defense.
    const result = await runCreateNew({
      parent: tmpRoot,
      name: '../../escape',
      editors: [...ALL_EDITOR_IDS],
    });
    // tmpdir() can sit at /var (a symlink to /private/var) on macOS; resolve()
    // doesn't follow symlinks but realpathSync does. Pin both: the literal
    // target lives under the literal parent, AND projectDir (a realpath)
    // lives under the parent's realpath. Either alone misses one failure mode.
    expect(result.target.startsWith(tmpRoot)).toBe(true);
    expect(result.projectDir.startsWith(realpathSync(tmpRoot))).toBe(true);
    // The sanitizer collapses '../../escape' → 'escape' (separators are
    // replaced with '-' then leading dashes/dots are trimmed).
    expect(result.target).toBe(join(tmpRoot, 'escape'));
  });

  test('surfaces mkdir-failed when the parent is not writable', async () => {
    // Force EACCES on mkdir by chmod'ing the parent to read+execute only.
    // tracedMkdirSync(target, { recursive: true }) attempts to create a
    // subdirectory and throws EACCES — the handler catches and surfaces
    // CreateNewProjectError('mkdir-failed', ...).
    const parent = join(tmpRoot, 'readonly');
    mkdirSync(parent);
    chmodSync(parent, 0o555);
    try {
      await runCreateNew({
        parent,
        name: 'locked',
        editors: [...ALL_EDITOR_IDS],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('mkdir-failed');
    } finally {
      // Restore so the global afterEach can rm the tree cleanly even if the
      // chmodSync above silently no-op'd on a future platform.
      chmodSync(parent, 0o755);
    }
  });
});

describe('runCreateNew — idempotency', () => {
  test('retry after success completes without error', async () => {
    const parent = tmpRoot;
    const first = await runCreateNew({
      parent,
      name: 'retry',
      editors: [...ALL_EDITOR_IDS],
    });
    // Read config.yml content; the retry should NOT overwrite it.
    const firstConfig = readFileSync(join(first.target, '.ok/config.yml'), 'utf8');
    // Touch the config so we can detect that initContent's writeIfMissing
    // semantics preserve the marker.
    writeFileSync(join(first.target, '.ok/config.yml'), `${firstConfig}\n# tampered\n`);

    // A second call would normally hit the target-not-empty guard. The
    // contract is: a mid-step retry succeeds, but a fully-landed retry
    // signals to the user that the folder is already occupied. Verify the
    // second call surfaces the structured target-not-empty error so the
    // dialog can point at the half/fully-created folder.
    try {
      await runCreateNew({
        parent,
        name: 'retry',
        editors: [...ALL_EDITOR_IDS],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CreateNewProjectError);
      expect((err as CreateNewProjectError).reason).toBe('target-not-empty');
    }
    // Tampered config is preserved — the retry did NOT clobber.
    expect(readFileSync(join(first.target, '.ok/config.yml'), 'utf8')).toContain('# tampered');
  });
});

describe('runCreateNew — installs the project-local skill (PRD-6733)', () => {
  // Regression pin: the desktop project-setup path
  // (`writeProjectAiIntegrations`) previously wired MCP config ONLY — the
  // project-local runtime `open-knowledge` skill was never created, so a
  // Desktop-primary user got a project with no agent behavioral contract.
  // `writeProjectAiIntegrations` now routes through `applyProjectIntegrations`
  // (the same orchestrator the onboarding-consent path uses), so both desktop
  // project-setup entry points install the skill.
  test('installs the open-knowledge project skill for claude, cursor, and codex', async () => {
    const result = await runCreateNew({
      parent: tmpRoot,
      name: 'Skill Install',
      editors: [...ALL_EDITOR_IDS],
    });

    expect(
      existsSync(join(result.projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(join(result.projectDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(join(result.projectDir, '.codex', 'skills', 'open-knowledge', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(join(result.projectDir, '.opencode', 'skills', 'open-knowledge', 'SKILL.md')),
    ).toBe(true);

    // The result's `aiIntegrations` carries the per-(editor × integration)
    // outcomes — the project-skill writer ran and reported success for every
    // editor that has a project skill surface.
    const skillWrites = result.aiIntegrations.integrations.filter(
      (o) => o.integration === 'project-skill' && o.action === 'written',
    );
    expect(skillWrites.map((o) => o.editorId).sort()).toEqual([
      'claude',
      'codex',
      'cursor',
      'opencode',
    ]);
  });
});
