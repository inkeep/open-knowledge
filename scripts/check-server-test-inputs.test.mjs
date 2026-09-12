import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  escapingReads,
  globalDependencyCovers,
  KNOWN_UNSWEPT,
  knownUnsweptWitness,
  missingKnownUnswept,
  packageRelativeGlobCovers,
  uncoveredReads,
} from './check-server-test-inputs.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TASK = '@inkeep/open-knowledge-server#test';

function fixtureRootWithout(glob) {
  const turbo = JSON.parse(readFileSync(join(OK_ROOT, 'turbo.json'), 'utf-8'));
  const inputs = turbo.tasks[TASK].inputs;
  expect(inputs, `fixture precondition: ${glob} must be declared`).toContain(glob);
  turbo.tasks[TASK].inputs = inputs.filter((entry) => entry !== glob);

  const root = mkdtempSync(join(tmpdir(), 'ok-server-inputs-'));
  writeFileSync(join(root, 'turbo.json'), JSON.stringify(turbo, null, 2));

  for (const [target, readers] of escapingReads(OK_ROOT)) {
    for (const reader of readers) {
      const dest = join(root, 'packages/server', reader);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(OK_ROOT, 'packages/server', reader), 'utf-8'));
    }
    const targetPath = join(root, target);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, '');
  }
  return root;
}

describe('check-server-test-inputs', () => {
  test('the live tree is clean: every escaping read is a declared input', () => {
    expect(uncoveredReads()).toEqual([]);
  });

  test('the sweep finds a non-trivial corpus, so a green is not vacuous', () => {
    expect(escapingReads().size).toBeGreaterThan(5);
  });

  test.each([
    ['../../docs/content/**', 'docs/content/'],
    ['../*/package.json', 'packages/app/package.json'],
    ['../cli/tsdown.config.ts', 'packages/cli/tsdown.config.ts'],
    ['../plugin/**', 'packages/plugin'],
    ['../../plugins/ok/**', 'plugins/ok'],
  ])('reds when %s is dropped from the task inputs', (glob, expectedTarget) => {
    const uncovered = uncoveredReads(fixtureRootWithout(glob));
    expect(uncovered.length).toBeGreaterThan(0);
    expect(uncovered.map((entry) => entry.target).join('\n')).toContain(expectedTarget);
  });

  test.each(Object.keys(KNOWN_UNSWEPT))(
    'reds when %s is dropped, even though the sweep cannot see its reader',
    (glob) => {
      const root = fixtureRootWithout(glob);
      expect(missingKnownUnswept(root)).toEqual([glob]);
    },
  );

  test('every KNOWN_UNSWEPT glob is genuinely in the blind spot, not just listed', () => {
    for (const glob of Object.keys(KNOWN_UNSWEPT)) {
      const root = fixtureRootWithout(glob);
      expect(
        uncoveredReads(root),
        `${glob} IS derivable now - drop it from KNOWN_UNSWEPT rather than pinning it twice`,
      ).toEqual([]);
    }
  });

  test('every KNOWN_UNSWEPT entry carries a reason', () => {
    for (const [glob, reason] of Object.entries(KNOWN_UNSWEPT)) {
      expect(reason, glob).toMatch(/\S/);
    }
  });

  test('a trailing /** covers the directory itself, not only paths beneath it', () => {
    expect(packageRelativeGlobCovers('../cli/src/**', 'packages/cli/src')).toBe(true);
    expect(packageRelativeGlobCovers('../cli/src/**', 'packages/cli/src/index.ts')).toBe(true);
    expect(packageRelativeGlobCovers('../cli/src/**', 'packages/cli/tsdown.config.ts')).toBe(false);
  });

  test('a single-segment * does not cross a directory boundary', () => {
    expect(packageRelativeGlobCovers('../*/package.json', 'packages/app/package.json')).toBe(true);
    expect(packageRelativeGlobCovers('../*/package.json', 'packages/app/src/package.json')).toBe(
      false,
    );
  });

  test('globalDependencyCovers escapes glob metacharacters before matching', () => {
    expect(globalDependencyCovers('turbo-cache-key.json', 'turbo-cache-key.json')).toBe(true);
    expect(globalDependencyCovers('turbo-cache-key.json', 'turbo-cache-keyXjson')).toBe(false);
    expect(globalDependencyCovers('patches/*.patch', 'patches/a.patch')).toBe(true);
    expect(globalDependencyCovers('patches/*.patch', 'patches/nested/a.patch')).toBe(false);
  });

  test('globalDependencyCovers honours a trailing globstar like its sibling', () => {
    expect(globalDependencyCovers('generated/**', 'generated')).toBe(true);
    expect(globalDependencyCovers('generated/**', 'generated/a/b.ts')).toBe(true);
    expect(globalDependencyCovers('generated/**', 'generated-other')).toBe(false);
  });

  test('a KNOWN_UNSWEPT pin is satisfied by coverage, not by its exact spelling', () => {
    const root = fixtureRootWithout('../../lint-plugins/**');
    const turboPath = join(root, 'turbo.json');
    const turbo = JSON.parse(readFileSync(turboPath, 'utf-8'));
    turbo.tasks[TASK].inputs.push('../../**');
    writeFileSync(turboPath, JSON.stringify(turbo, null, 2));
    expect(missingKnownUnswept(root)).toEqual([]);
  });

  test('a KNOWN_UNSWEPT pin whose coverage is actually gone still reds', () => {
    expect(missingKnownUnswept(fixtureRootWithout('../../lint-plugins/**'))).toEqual([
      '../../lint-plugins/**',
    ]);
  });

  test('knownUnsweptWitness trims only a trailing globstar', () => {
    expect(knownUnsweptWitness('../../lint-plugins/**')).toBe('../../lint-plugins');
    expect(knownUnsweptWitness('../../oxlint.config.ts')).toBe('../../oxlint.config.ts');
  });

  test('the CLI entry point exits 0 and prints its OK line on the real tree', () => {
    const script = fileURLToPath(new URL('./check-server-test-inputs.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script], { encoding: 'utf-8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/check:server-test-inputs: OK/);
  });
});
