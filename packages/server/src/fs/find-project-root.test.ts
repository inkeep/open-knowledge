import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findEnclosingProjectRoot } from './find-project-root.ts';

describe('findEnclosingProjectRoot', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'find-project-root-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(dir: string): void {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(join(dir, '.ok', 'config.yml'), 'version: 1\n');
  }

  test('returns { rootPath: dir, distance: 0 } when dir itself has .ok/config.yml', () => {
    writeConfig(root);
    const result = findEnclosingProjectRoot(root);
    expect(result).toEqual({ rootPath: root, distance: 0 });
  });

  test('returns ancestor with positive distance when an ancestor has .ok/config.yml', () => {
    writeConfig(root);
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const result = findEnclosingProjectRoot(nested);
    expect(result).toEqual({ rootPath: root, distance: 3 });
  });

  test('returns null when no ancestor up to filesystem root has .ok/config.yml', () => {
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const result = findEnclosingProjectRoot(nested);
    expect(result).toBeNull();
  });

  test('half-init folder (.ok/.gitignore exists but no config.yml) returns null', () => {
    mkdirSync(join(root, '.ok'), { recursive: true });
    writeFileSync(join(root, '.ok', '.gitignore'), 'local/\n');
    const result = findEnclosingProjectRoot(root);
    expect(result).toBeNull();
  });

  test('folder with only .ok/frontmatter.yml (nested folder rule) returns null', () => {
    mkdirSync(join(root, '.ok'), { recursive: true });
    writeFileSync(join(root, '.ok', 'frontmatter.yml'), 'tags: []\n');
    const result = findEnclosingProjectRoot(root);
    expect(result).toBeNull();
  });

  test('symlink directory: path.resolve does NOT follow the link, so helper returns null', () => {
    const realProject = join(root, 'real-project');
    mkdirSync(realProject, { recursive: true });
    writeConfig(realProject);

    const linkLocation = join(root, 'link-to-nested');
    const linkTarget = join(realProject, 'subdir');
    mkdirSync(linkTarget, { recursive: true });
    symlinkSync(linkTarget, linkLocation);

    const result = findEnclosingProjectRoot(linkLocation);
    expect(result).toBeNull();
  });

  test('deeply nested temp dir with no .ok anywhere returns null without infinite-looping', () => {
    let cursor = root;
    for (let i = 0; i < 8; i++) {
      cursor = join(cursor, `level-${i}`);
    }
    mkdirSync(cursor, { recursive: true });
    const result = findEnclosingProjectRoot(cursor);
    expect(result).toBeNull();
  });
});
