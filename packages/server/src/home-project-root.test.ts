import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  assertSafeProjectRoot,
  FilesystemRootProjectError,
  HomeProjectRootError,
  isFilesystemRoot,
  isHomeDir,
} from './home-project-root.ts';
import { initContent } from './init-project.ts';
import { ensureProjectGit } from './project-git.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-home-guard-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('isHomeDir', () => {
  test('true for home, false for a folder inside it', () => {
    expect(isHomeDir(home, home)).toBe(true);
    expect(isHomeDir(join(home, 'notes'), home)).toBe(false);
  });

  test('a symlinked spelling of home still compares equal', () => {
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

describe('assertSafeProjectRoot', () => {
  test('throws for home, carrying the resolved path', () => {
    try {
      assertSafeProjectRoot(home, home);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HomeProjectRootError);
      expect((err as HomeProjectRootError).projectRoot).toBe(resolve(home));
    }
  });

  test('throws for the filesystem root, carrying the resolved path', () => {
    try {
      assertSafeProjectRoot('/', home);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FilesystemRootProjectError);
      expect((err as FilesystemRootProjectError).projectRoot).toBe(resolve('/'));
      expect((err as FilesystemRootProjectError).message).toContain('top of a drive');
    }
  });

  test('is silent for any other directory', () => {
    expect(() => assertSafeProjectRoot(join(home, 'notes'), home)).not.toThrow();
    expect(() => assertSafeProjectRoot(home, join(home, 'other-home'))).not.toThrow();
  });
});

describe('isFilesystemRoot', () => {
  test('true for the host root and for a relative spelling of it', () => {
    expect(isFilesystemRoot('/')).toBe(true);
    expect(isFilesystemRoot(join(home, ...home.split(sep).map(() => '..')))).toBe(true);
  });

  test('false for ordinary directories, including top-level ones', () => {
    expect(isFilesystemRoot(home)).toBe(false);
    expect(isFilesystemRoot(tmpdir())).toBe(false);
    expect(isFilesystemRoot('/opt', 'linux')).toBe(false);
  });

  test.each(['C:\\', 'C:/', 'd:\\'])('true for the Windows drive root %s', (dir) => {
    expect(isFilesystemRoot(dir, 'win32')).toBe(true);
  });

  test.skipIf(process.platform === 'win32').each(['\\\\server\\share', '\\\\server\\share\\'])(
    'true for the Windows share root %s',
    (dir) => {
      expect(isFilesystemRoot(dir, 'win32')).toBe(true);
    },
  );

  test.each(['C:\\Users', 'C:\\notes'])('false for the Windows folder %s', (dir) => {
    expect(isFilesystemRoot(dir, 'win32')).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('false for a folder inside a Windows share', () => {
    expect(isFilesystemRoot('\\\\server\\share\\notes', 'win32')).toBe(false);
  });

  test('the macOS data volume counts as a root on darwin only', () => {
    expect(isFilesystemRoot('/System/Volumes/Data', 'darwin')).toBe(true);
    expect(isFilesystemRoot('/System/Volumes/Data/notes', 'darwin')).toBe(false);
    expect(isFilesystemRoot('/System/Volumes/Data', 'linux')).toBe(false);
  });
});

describe('scaffold writers refuse $HOME', () => {
  test('ensureProjectGit does not git init the home directory', async () => {
    vi.stubEnv('HOME', home);
    await expect(ensureProjectGit(home)).rejects.toBeInstanceOf(HomeProjectRootError);
    expect(existsSync(join(home, '.git'))).toBe(false);
  });

  test('initContent does not scaffold into the user-global ~/.ok', () => {
    vi.stubEnv('HOME', home);
    expect(() => initContent(home)).toThrow(HomeProjectRootError);
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
