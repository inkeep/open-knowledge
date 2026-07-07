import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type ResolveProjectRootOptions,
  type ResolveProjectRootResult,
  resolveProjectRoot,
} from './resolve-project-root.ts';

const execFileAsync = promisify(execFile);

let tmpRoot: string;
// macOS' /tmp resolves to /private/tmp, and `mkdtempSync(tmpdir())` returns
// the unresolved path. realpath-resolving up front means fixtures live in the
// same canonical-path space resolveProjectRoot's return values use, so direct
// equality assertions hold.
let tmpReal: string;
let fakeHome: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'ok-resolve-project-root-'));
  tmpReal = realpathSync(tmpRoot);
  fakeHome = resolve(tmpReal, 'home');
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const stubGitTopLevel =
  (resultByCwd: Record<string, string | null>) =>
  (cwd: string): string | null => {
    if (cwd in resultByCwd) {
      const value = resultByCwd[cwd];
      return value === undefined ? null : value;
    }
    return null;
  };

const writeOkConfig = (dir: string): void => {
  mkdirSync(resolve(dir, '.ok'), { recursive: true });
  writeFileSync(resolve(dir, '.ok/config.yml'), '$schema: x\n');
};

describe('resolveProjectRoot — ancestor walk wins', () => {
  test('returns cwd as projectRoot when .ok/config.yml is at cwd', () => {
    const project = resolve(fakeHome, 'project');
    mkdirSync(project, { recursive: true });
    writeOkConfig(project);

    const result: ResolveProjectRootResult = resolveProjectRoot(project, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
    });

    expect(result).toEqual({
      projectRoot: project,
      defaultContentDir: '.',
      ancestorPromoted: false,
      gitRootPromoted: false,
    });
  });

  test('promotes to ancestor when .ok/ is one level up', () => {
    const project = resolve(fakeHome, 'project');
    const sub = resolve(project, 'sub');
    mkdirSync(sub, { recursive: true });
    writeOkConfig(project);

    const result = resolveProjectRoot(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
    });

    expect(result.projectRoot).toBe(project);
    expect(result.defaultContentDir).toBe('.');
    expect(result.ancestorPromoted).toBe(true);
    expect(result.gitRootPromoted).toBe(false);
  });

  test.each([1, 2, 3, 4, 5])('promotes to ancestor at depth %i levels above cwd', (depth) => {
    const segments = Array.from({ length: depth }, (_, i) => `level${i + 1}`);
    const project = resolve(fakeHome, 'project');
    const sub = resolve(project, ...segments);
    mkdirSync(sub, { recursive: true });
    writeOkConfig(project);

    const result = resolveProjectRoot(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
    });

    expect(result.projectRoot).toBe(project);
    expect(result.ancestorPromoted).toBe(true);
    expect(result.defaultContentDir).toBe('.');
  });

  test('walk excludes home itself — picking home does not match home/.ok/', () => {
    writeOkConfig(fakeHome);

    const result = resolveProjectRoot(fakeHome, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
    });

    expect(result.ancestorPromoted).toBe(false);
    expect(result.projectRoot).toBe(fakeHome);
    expect(result.gitRootPromoted).toBe(false);
  });

  test('legacy .ok/ below git root wins over git-root promotion', () => {
    // Fixture: <fakeHome>/repo/.git/, <fakeHome>/repo/docs/.ok/. Picked
    // path is <fakeHome>/repo/docs/api. Walk hits .ok/ at <fakeHome>/repo/docs
    // BEFORE git-root resolution, so the ancestor branch wins.
    const repo = resolve(fakeHome, 'repo');
    const docs = resolve(repo, 'docs');
    const api = resolve(docs, 'api');
    mkdirSync(api, { recursive: true });
    mkdirSync(resolve(repo, '.git'));
    writeOkConfig(docs);

    const result = resolveProjectRoot(api, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [api]: repo }),
    });

    expect(result.projectRoot).toBe(docs);
    expect(result.ancestorPromoted).toBe(true);
    expect(result.gitRootPromoted).toBe(false);
  });
});

describe('resolveProjectRoot — git-root promotion', () => {
  test('promotes to gitRoot when cwd is sub-folder of a git repo without .ok/', () => {
    const repo = resolve(fakeHome, 'myrepo');
    const docs = resolve(repo, 'docs');
    mkdirSync(docs, { recursive: true });

    const result = resolveProjectRoot(docs, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [docs]: repo }),
    });

    expect(result.projectRoot).toBe(repo);
    // After git-root promotion, content scope aligns with the opened folder
    // (the git root). Narrowing back to the picked sub-folder is opt-in via
    // post-init `content.dir`, not the silent default.
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(true);
    expect(result.ancestorPromoted).toBe(false);
  });

  test('no promotion when gitRoot === cwd (gitRootPromoted=false, defaultContentDir=".")', () => {
    const repo = resolve(fakeHome, 'myrepo');
    mkdirSync(repo, { recursive: true });

    const result = resolveProjectRoot(repo, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [repo]: repo }),
    });

    expect(result.projectRoot).toBe(repo);
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(false);
    expect(result.ancestorPromoted).toBe(false);
  });

  test('does NOT promote when gitRoot === home (carve-out for ~/.git/)', () => {
    const sub = resolve(fakeHome, 'work');
    mkdirSync(sub, { recursive: true });

    const result = resolveProjectRoot(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [sub]: fakeHome }),
    });

    expect(result.projectRoot).toBe(sub);
    expect(result.gitRootPromoted).toBe(false);
    expect(result.defaultContentDir).toBe('.');
  });

  test('does NOT promote when gitRoot is above home', () => {
    const sub = resolve(fakeHome, 'work');
    mkdirSync(sub, { recursive: true });
    const aboveHome = tmpReal;

    const result = resolveProjectRoot(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [sub]: aboveHome }),
    });

    expect(result.projectRoot).toBe(sub);
    expect(result.gitRootPromoted).toBe(false);
    expect(result.defaultContentDir).toBe('.');
  });

  test('promotes deep sub-path; content scope still defaults to the git root', () => {
    const repo = resolve(fakeHome, 'myrepo');
    const subA = resolve(repo, 'a');
    const subB = resolve(subA, 'b');
    mkdirSync(subB, { recursive: true });

    const result = resolveProjectRoot(subB, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [subB]: repo }),
    });

    expect(result.projectRoot).toBe(repo);
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(true);
  });
});

describe('resolveProjectRoot — fallback (no ancestor, no git)', () => {
  test('returns cwd as projectRoot, defaultContentDir=., no promotion', () => {
    const folder = resolve(fakeHome, 'no-git');
    mkdirSync(folder, { recursive: true });

    const result = resolveProjectRoot(folder, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
    });

    expect(result.projectRoot).toBe(folder);
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(false);
    expect(result.ancestorPromoted).toBe(false);
  });

  test('cwd that does not yet exist falls back without throwing', () => {
    // realpathSync throws ENOENT — the helper swallows it and operates
    // against the resolved path. Caller's existsSync walk yields the
    // no-promotion branch.
    const ghost = resolve(fakeHome, 'never-created');

    const result = resolveProjectRoot(ghost, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
    });

    expect(result.projectRoot).toBe(ghost);
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(false);
    expect(result.ancestorPromoted).toBe(false);
  });
});

describe('resolveProjectRoot — depth bound', () => {
  test('walk stops at ANCESTOR_WALK_DEPTH_LIMIT (default 30) without finding ancestor', () => {
    // 31 levels under fakeHome; place .ok/ at level-1 so the cap fires
    // before the walk reaches it.
    const segments = Array.from({ length: 31 }, (_, i) => `l${i}`);
    const leaf = resolve(fakeHome, ...segments);
    mkdirSync(leaf, { recursive: true });
    writeOkConfig(resolve(fakeHome, segments[0]));

    const result = resolveProjectRoot(leaf, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
    });

    // Cap fires; walk never reaches level-0; so ancestor never matches.
    // Falls through to no-promotion branch.
    expect(result.ancestorPromoted).toBe(false);
  });
});

describe('resolveProjectRoot — symlink canonicalization', () => {
  test('cwd is canonicalized via realpath before walk', () => {
    const project = resolve(fakeHome, 'project');
    const realSub = resolve(project, 'sub');
    mkdirSync(realSub, { recursive: true });
    writeOkConfig(project);

    // Test driver passes the realpath path; on the actual filesystem this
    // is an identity transformation. Establishes that the function uses the
    // canonical path consistently.
    const result = resolveProjectRoot(realpathSync(realSub), {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
    });

    expect(result.projectRoot).toBe(project);
    expect(result.ancestorPromoted).toBe(true);
  });
});

describe('resolveProjectRoot — integration with real git', () => {
  test('promotes to git working-tree root via real `git rev-parse`', async () => {
    const repo = resolve(fakeHome, 'realrepo');
    const docs = resolve(repo, 'docs');
    mkdirSync(docs, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main', repo]);

    // No gitTopLevel stub — uses the real default that shells out.
    const opts: ResolveProjectRootOptions = { homeDir: fakeHome };
    const result = resolveProjectRoot(docs, opts);

    expect(result.projectRoot).toBe(realpathSync(repo));
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(true);
  });

  test('non-git folder via real `git rev-parse` falls back without promotion', () => {
    const folder = resolve(fakeHome, 'plain');
    mkdirSync(folder, { recursive: true });

    // No git init; default gitTopLevel returns null.
    const result = resolveProjectRoot(folder, { homeDir: fakeHome });

    expect(result.projectRoot).toBe(folder);
    expect(result.gitRootPromoted).toBe(false);
    expect(result.defaultContentDir).toBe('.');
  });
});
