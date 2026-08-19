import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { assertNotHomeProjectRoot, HomeProjectRootError, isHomeDir } from './home-project-root.ts';
import { initContent } from './init-project.ts';
import { ensureProjectGit } from './project-git.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-home-guard-'));
});

afterEach(() => {
  // The writer tests point `os.homedir()` at the fixture; unstub so a later
  // test in this file can't inherit a HOME that names a deleted directory.
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('isHomeDir', () => {
  test('true for home, false for a folder inside it', () => {
    expect(isHomeDir(home, home)).toBe(true);
    expect(isHomeDir(join(home, 'notes'), home)).toBe(false);
  });

  test('a symlinked spelling of home still compares equal', () => {
    // The two operands reach the writers by different routes (a user-supplied
    // path or a folder pick vs `os.homedir()`), so `===` is not enough.
    const link = join(tmpdir(), `ok-home-guard-link-${process.pid}`);
    try {
      symlinkSync(home, link);
      expect(isHomeDir(link, home)).toBe(true);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test('a relative spelling resolves before comparing', () => {
    expect(isHomeDir(join(home, 'notes', '..'), home)).toBe(true);
  });
});

describe('assertNotHomeProjectRoot', () => {
  test('throws for home, carrying the resolved path', () => {
    try {
      assertNotHomeProjectRoot(home, home);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HomeProjectRootError);
      expect((err as HomeProjectRootError).projectRoot).toBe(resolve(home));
    }
  });

  test('is silent for any other directory', () => {
    expect(() => assertNotHomeProjectRoot(join(home, 'notes'), home)).not.toThrow();
  });
});

/**
 * The two shared writers every scaffold entry point passes through: `ok init`,
 * `ok share publish --project-dir`, the desktop Open Folder confirm, the
 * desktop `ok-init` IPC and `POST /api/local-op/ok-init`. Guarding them is what
 * makes the refusal hold for the four non-CLI entry points, which have no
 * `runInit` in front of them.
 */
describe('scaffold writers refuse $HOME', () => {
  test('ensureProjectGit does not git init the home directory', async () => {
    vi.stubEnv('HOME', home);
    await expect(ensureProjectGit(home)).rejects.toBeInstanceOf(HomeProjectRootError);
    expect(existsSync(join(home, '.git'))).toBe(false);
  });

  test('initContent does not scaffold into the user-global ~/.ok', () => {
    vi.stubEnv('HOME', home);
    expect(() => initContent(home)).toThrow(HomeProjectRootError);
    // `.ok/` at home is the user-global store; a scaffold would drop a project
    // `config.yml` into it.
    expect(existsSync(join(home, '.ok', 'config.yml'))).toBe(false);
    expect(existsSync(join(home, '.okignore'))).toBe(false);
  });

  test('a project inside home still scaffolds', () => {
    vi.stubEnv('HOME', home);
    const project = join(home, 'notes');
    const result = initContent(project);
    expect(result.created).toContain('config.yml');
  });
});
