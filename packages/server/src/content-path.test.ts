import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { safeContentPath } from './content-path.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-content-scope-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function markProject(path: string): void {
  mkdirSync(join(path, '.ok'), { recursive: true });
  writeFileSync(join(path, '.ok', 'config.yml'), '');
}

test('refuses existing and new documents owned by a nested project', () => {
  const child = join(root, 'child');
  markProject(root);
  markProject(child);
  writeFileSync(join(child, 'existing.md'), '# Child\n');
  expect(() => safeContentPath('child/existing', root)).toThrow(/nested project/i);
  expect(() => safeContentPath('child/new/deep', root)).toThrow(/nested project/i);
  expect(safeContentPath('existing', child)).toBe(join(child, 'existing.md'));
});

test('folder metadata does not split project ownership', () => {
  mkdirSync(join(root, 'notes', '.ok'), { recursive: true });
  writeFileSync(join(root, 'notes', '.ok', 'frontmatter.yml'), 'icon: note\n');
  expect(safeContentPath('notes/new', root)).toBe(join(root, 'notes', 'new.md'));
});

test('detects a project marker created after an earlier path resolution', () => {
  expect(safeContentPath('child/new', root)).toBe(join(root, 'child', 'new.md'));
  markProject(join(root, 'child'));
  expect(() => safeContentPath('child/new', root)).toThrow(/nested project/i);
});

test('refuses an alias into a nested project, including a missing destination', () => {
  const child = join(root, 'child');
  markProject(child);
  writeFileSync(join(child, 'existing.md'), '# Child\n');
  symlinkSync(child, join(root, 'alias'), 'junction');
  symlinkSync(join(child, 'existing.md'), join(root, 'file-alias.md'), 'file');
  expect(() => safeContentPath('file-alias', root)).toThrow(/nested project/i);
  expect(() => safeContentPath('alias/existing', root)).toThrow(/nested project/i);
  expect(() => safeContentPath('alias/new/deep', root)).toThrow(/nested project/i);
});

test('a symlink to the current project root does not create a new project', () => {
  markProject(root);
  writeFileSync(join(root, 'own.md'), '# Own\n');
  symlinkSync(root, join(root, 'self'), 'junction');
  expect(safeContentPath('self/own', root)).toBe(join(root, 'self', 'own.md'));
});
