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


let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ok-create-new-'));
});

afterEach(() => {
  try {
    chmodSync(tmpRoot, 0o755);
  } catch {
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
  test('scaffolds .ok/config.yml at git root; content.dir defaults to the git root, not the picked sub-folder', async () => {
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

    expect(result.projectDir).toBe(repo);
    expect(result.target).toBe(target);
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(true);
    expect(result.variant).toBe('create-new-default');

    expect(existsSync(resolve(repo, '.ok/config.yml'))).toBe(true);
    expect(existsSync(resolve(target, '.ok/config.yml'))).toBe(false);

    expect(existsSync(target)).toBe(true);

    const cfg = readFileSync(resolve(repo, '.ok/config.yml'), 'utf8');
    expect(cfg).not.toMatch(/^\s*dir:\s*notes\/MyProj/m);

    expect(existsSync(resolve(repo, '.gitignore'))).toBe(false);
  });

  test('no promotion when parent has no enclosing git repo — projectDir === target, content.dir === "."', async () => {
    const tmpReal = realpathSync(tmpRoot);
    const fakeHome = resolve(tmpReal, 'home');
    const parent = resolve(fakeHome, 'plain');
    mkdirSync(parent, { recursive: true });

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
    expect(cfg).not.toMatch(/^\s*dir:\s*\S/m);
  });

  test('throws discovery-failed when discoverProject returns rejected (symlink-escape)', async () => {
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
    const result = await runCreateNew({
      parent: tmpRoot,
      name: '../../escape',
      editors: [...ALL_EDITOR_IDS],
    });
    expect(result.target.startsWith(tmpRoot)).toBe(true);
    expect(result.projectDir.startsWith(realpathSync(tmpRoot))).toBe(true);
    expect(result.target).toBe(join(tmpRoot, 'escape'));
  });

  test('surfaces mkdir-failed when the parent is not writable', async () => {
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
    const firstConfig = readFileSync(join(first.target, '.ok/config.yml'), 'utf8');
    writeFileSync(join(first.target, '.ok/config.yml'), `${firstConfig}\n# tampered\n`);

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
    expect(readFileSync(join(first.target, '.ok/config.yml'), 'utf8')).toContain('# tampered');
  });
});

describe('runCreateNew — installs the project-local skill (PRD-6733)', () => {
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
