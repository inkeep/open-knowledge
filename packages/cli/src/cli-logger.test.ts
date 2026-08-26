import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveLogProject } from './cli-logger.ts';

const cleanups: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}
function makeProject(root: string): void {
  mkdirSync(join(root, '.ok'), { recursive: true });
  writeFileSync(join(root, '.ok', 'config.yml'), 'content:\n  dir: .\n', 'utf-8');
}

afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveLogProject', () => {
  test('a configured project name wins', () => {
    const root = tmp('ok-log-named-');
    makeProject(root);
    expect(resolveLogProject(root, 'my-kb')).toBe('my-kb');
  });

  test('inside a project with no name → the resolved project root, not a placeholder', () => {
    const root = tmp('ok-log-root-');
    makeProject(root);
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(resolveLogProject(sub)).toBe(root);
  });

  test('outside any project → undefined (the record carries no false project)', () => {
    expect(resolveLogProject(tmp('ok-log-bare-'))).toBeUndefined();
  });

  test('an empty configured name falls through to the resolved root', () => {
    const root = tmp('ok-log-empty-');
    makeProject(root);
    expect(resolveLogProject(root, '')).toBe(root);
  });
});
