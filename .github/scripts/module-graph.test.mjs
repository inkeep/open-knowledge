import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS, '..', '..');

const ROOTS = [
  ['.github/scripts', SCRIPTS],
  ['scripts', join(REPO_ROOT, 'scripts')],
];

const byRoot = ROOTS.map(([label, dir]) => ({
  label,
  entries: readdirSync(dir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => join(dir, name))
    .sort(),
}));

describe.each(byRoot)('$label', ({ entries }) => {
  test('the root contributed scripts to the sweep', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  test.each(entries.map((path) => [relative(REPO_ROOT, path), path]))(
    '%s links under real node',
    (_label, path) => {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path).href)})`],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 20_000 },
      );

      expect(result.error).toBeUndefined();
      expect(result.stderr).not.toMatch(/does not provide an export named/);
      expect(result.stdout).toBe('');
      expect(result.status, result.stderr || '(no stderr)').toBe(0);
    },
  );
});
