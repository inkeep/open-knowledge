import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { okUserHomeDir } from '../constants/ok-user-home.ts';
import { okProjectLogsDir } from './project-logs-dir.ts';

const directories: string[] = [];

function fixture(): { project: string; home: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ok-project-logs-'));
  directories.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  return { project, home: join(root, 'home'), root };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('uses an opaque project namespace below the product user logs without creating directories', () => {
  const { project, home } = fixture();
  const path = okProjectLogsDir(project, home);

  expect(dirname(path)).toBe(join(okUserHomeDir(home), 'logs', 'projects'));
  expect(basename(path)).toMatch(/^[a-f0-9]{64}$/);
  expect(okProjectLogsDir(join(project, 'child', '..'), home)).toBe(path);
  expect(existsSync(home)).toBe(false);
});

test('isolates two projects with the same basename', () => {
  const first = fixture();
  const second = fixture();

  expect(okProjectLogsDir(first.project, first.home)).not.toBe(
    okProjectLogsDir(second.project, first.home),
  );
});

test('an existing symlink spelling uses the same project namespace', () => {
  const { project, home, root } = fixture();
  const alias = join(root, 'alias');
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');

  expect(okProjectLogsDir(alias, home)).toBe(okProjectLogsDir(project, home));
});

test('a missing project still has a read-only namespaced location', () => {
  const { project, home, root } = fixture();
  const missing = join(root, 'missing');
  const path = okProjectLogsDir(missing, home);

  expect(dirname(path)).toBe(join(okUserHomeDir(home), 'logs', 'projects'));
  expect(basename(path)).toMatch(/^[a-f0-9]{64}$/);
  expect(path).not.toBe(okProjectLogsDir(project, home));
  expect(existsSync(missing)).toBe(false);
  expect(existsSync(home)).toBe(false);
});
