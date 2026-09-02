import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { projectSkill } from './skill-projection.ts';

let cwd: string;

function makeSource(name: string): string {
  const dir = join(cwd, '.ok', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nBody.\n`);
  return dir;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ok-projection-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('projectSkill mode', () => {
  test('copy writes a real dir that survives source removal', () => {
    const src = makeSource('acquired');
    const hosts = projectSkill(src, 'acquired', cwd, ['claude'], 'copy');
    expect(hosts).toEqual(['claude']);
    const dest = join(cwd, '.claude', 'skills', 'acquired');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(dest).isDirectory()).toBe(true);
    rmSync(src, { recursive: true, force: true });
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
  });

  test('symlink (default) stays a link', () => {
    const src = makeSource('local');
    projectSkill(src, 'local', cwd, ['claude']);
    const dest = join(cwd, '.claude', 'skills', 'local');
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
  });
});
