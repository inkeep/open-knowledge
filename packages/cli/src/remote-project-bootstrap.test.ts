import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  inspectRemoteProject,
  prepareRemoteProject,
  RemoteCompanionError,
  validateRemoteContentDirectory,
} from './remote-project-bootstrap.ts';

const roots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-remote-project-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('remote project inspection and initialization', () => {
  test('inspection reports the canonical selected folder without writing a project', () => {
    const root = temporaryDirectory();

    expect(inspectRemoteProject(root)).toEqual({
      v: 1,
      selectedPath: realpathSync.native(root),
      projectPath: realpathSync.native(root),
      initialized: false,
    });
    expect(existsSync(join(root, '.ok'))).toBe(false);
  });

  test('does not mistake per-user remote support for an incomplete ancestor project', () => {
    const outer = temporaryDirectory();
    const home = join(outer, 'home');
    const selected = join(home, 'projects', 'wiki');
    mkdirSync(join(outer, '.ok'));
    writeFileSync(join(outer, '.ok', 'config.yml'), 'content:\n  dir: .\n');
    mkdirSync(join(home, '.ok', 'remote'), { recursive: true });
    mkdirSync(selected, { recursive: true });

    expect(inspectRemoteProject(selected, home)).toEqual({
      v: 1,
      selectedPath: realpathSync.native(selected),
      projectPath: realpathSync.native(selected),
      initialized: false,
    });
  });

  test('still inherits a complete project rooted at the remote home directory', () => {
    const home = temporaryDirectory();
    const selected = join(home, 'docs');
    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(join(home, '.ok', 'config.yml'), 'content:\n  dir: .\n');
    mkdirSync(selected);

    expect(inspectRemoteProject(home, home)).toEqual({
      v: 1,
      selectedPath: realpathSync.native(home),
      projectPath: realpathSync.native(home),
      initialized: true,
    });
    expect(inspectRemoteProject(selected, home)).toEqual({
      v: 1,
      selectedPath: realpathSync.native(selected),
      projectPath: realpathSync.native(home),
      initialized: true,
    });
  });

  test('treats a nested metadata directory without config.yml as a non-root', () => {
    const home = temporaryDirectory();
    const selected = join(home, 'work');
    mkdirSync(join(selected, '.ok'), { recursive: true });
    writeFileSync(join(selected, '.ok', 'frontmatter.yml'), 'title: Work\n');

    expect(inspectRemoteProject(selected, home)).toEqual({
      v: 1,
      selectedPath: realpathSync.native(selected),
      projectPath: realpathSync.native(selected),
      initialized: false,
    });
  });

  test('inspection rejects a symlinked project configuration instead of walking past it', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    mkdirSync(join(root, '.ok'));
    writeFileSync(join(outside, 'config.yml'), 'content:\n  dir: .\n');
    symlinkSync(join(outside, 'config.yml'), join(root, '.ok', 'config.yml'));

    expect(() => inspectRemoteProject(root)).toThrow(
      expect.objectContaining({ code: 'config-invalid' }),
    );
    expect(existsSync(join(root, '.okignore'))).toBe(false);
  });

  test('nested folder metadata inherits the nearest enclosing project', () => {
    const root = temporaryDirectory();
    prepareRemoteProject(root, realpathSync.native(root));
    const nested = join(root, 'nested');
    mkdirSync(join(nested, '.ok'), { recursive: true });
    writeFileSync(join(nested, '.ok', 'frontmatter.yml'), 'title: Nested\n');

    expect(inspectRemoteProject(nested)).toEqual({
      v: 1,
      selectedPath: realpathSync.native(nested),
      projectPath: realpathSync.native(root),
      initialized: true,
    });
  });

  test('serve refuses an unconfigured folder without explicit initialization', () => {
    const root = temporaryDirectory();

    expect(() => prepareRemoteProject(root)).toThrow(RemoteCompanionError);
    try {
      prepareRemoteProject(root);
    } catch (error) {
      expect(error).toMatchObject({ code: 'project-uninitialized' });
    }
    expect(existsSync(join(root, '.ok'))).toBe(false);
  });

  test('explicit initialization writes only the normal project scaffold', () => {
    const root = temporaryDirectory();

    expect(prepareRemoteProject(root, realpathSync.native(root))).toBe(realpathSync.native(root));
    expect(existsSync(join(root, '.ok', 'config.yml'))).toBe(true);
    expect(existsSync(join(root, '.ok', '.gitignore'))).toBe(true);
    expect(existsSync(join(root, '.okignore'))).toBe(true);
  });

  test('preserves an existing project configuration', () => {
    const root = temporaryDirectory();
    prepareRemoteProject(root, realpathSync.native(root));
    const configPath = join(root, '.ok', 'config.yml');
    writeFileSync(configPath, 'terminal:\n  enabled: false\n');

    expect(prepareRemoteProject(root)).toBe(realpathSync.native(root));
    expect(readFileSync(configPath, 'utf8')).toBe('terminal:\n  enabled: false\n');
  });

  test('uses the nearest enclosing project instead of initializing a nested folder', () => {
    const root = temporaryDirectory();
    prepareRemoteProject(root, realpathSync.native(root));
    const nested = join(root, 'docs', 'guides');
    mkdirSync(nested, { recursive: true });

    expect(inspectRemoteProject(nested)).toEqual({
      v: 1,
      selectedPath: realpathSync.native(nested),
      projectPath: realpathSync.native(root),
      initialized: true,
    });
    expect(prepareRemoteProject(nested)).toBe(realpathSync.native(root));
    expect(existsSync(join(nested, '.ok'))).toBe(false);
  });

  test('rejects initialization when the selected folder differs from the confirmed path', () => {
    const root = temporaryDirectory();
    const other = temporaryDirectory();

    expect(() => prepareRemoteProject(root, realpathSync.native(other))).toThrow(
      expect.objectContaining({ code: 'project-initialize-failed' }),
    );
    expect(existsSync(join(root, '.ok'))).toBe(false);
    expect(existsSync(join(other, '.ok'))).toBe(false);
  });
});

describe('validateRemoteContentDirectory', () => {
  test('accepts existing directories inside the project', () => {
    const root = temporaryDirectory();
    const docs = join(root, 'docs');
    mkdirSync(docs);

    expect(validateRemoteContentDirectory(root, '.')).toBe(realpathSync.native(root));
    expect(validateRemoteContentDirectory(root, 'docs')).toBe(realpathSync.native(docs));
  });

  test('rejects missing directories instead of creating through an untrusted ancestor', () => {
    const root = temporaryDirectory();

    expect(() => validateRemoteContentDirectory(root, 'new/nested')).toThrow(
      expect.objectContaining({ code: 'content-dir-outside-project' }),
    );
    expect(existsSync(join(root, 'new'))).toBe(false);
  });

  test.each(['..', '../outside'])('rejects lexical project escape %j', (configuredDir) => {
    const root = temporaryDirectory();

    expect(() => validateRemoteContentDirectory(root, configuredDir)).toThrow(
      expect.objectContaining({ code: 'content-dir-outside-project' }),
    );
  });

  test('rejects an in-project symlink whose target is outside the project', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    symlinkSync(outside, join(root, 'linked-content'), 'dir');

    expect(() => validateRemoteContentDirectory(root, 'linked-content')).toThrow(
      expect.objectContaining({ code: 'content-dir-outside-project' }),
    );
  });

  test('allows an in-project symlink whose canonical target remains inside', () => {
    const root = temporaryDirectory();
    const docs = join(root, 'docs');
    mkdirSync(docs);
    symlinkSync(docs, join(root, 'linked-content'), 'dir');

    expect(validateRemoteContentDirectory(root, 'linked-content')).toBe(realpathSync.native(docs));
  });
});
