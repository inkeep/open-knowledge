import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS, '..', '..');

/**
 * Node link-checks a module's named imports against its dependency's exports
 * BEFORE running a line of it, so an import naming a symbol its sibling no longer
 * exports is a load-time SyntaxError — on the next real run, whether the caller is
 * a workflow, a package script, or a human following a runbook.
 *
 * Most tests in these directories import their subject in-process, where Vite's
 * transform leaves a missing named import as `undefined` rather than a link error;
 * a handful already spawn real `node` and would catch it for their own subject.
 * What is new here is UNIFORM coverage — including every file whose tests never
 * leave the process, and every file with no test at all.
 *
 * Both script roots, which are one vitest project already
 * (`vitest.scripts.config.ts`) and do import across each other. They are not
 * alike otherwise: `.github/scripts/` is uniformly workflow-invoked and uniformly
 * guarded, while `scripts/` mixes workflow scripts, manual runbooks and an ad-hoc
 * analysis toolchain. That asymmetry is the argument FOR a sweep there rather than
 * hand-written per-script tests.
 *
 * `await import()` links the whole graph, and every main guard spelled across
 * these two roots declines to fire under it. That is a precondition on the swept
 * files rather than a property of this test, so the silence assertion below
 * checks the observable half of it — that nothing PRINTS — instead of trusting
 * the whole of it. Silence is a proxy: a module that reads, writes or spawns
 * quietly still passes, which is exactly how a sweep becomes a side effect of
 * the gate it runs inside.
 */
const ROOTS = [
  ['.github/scripts', SCRIPTS],
  ['scripts', join(REPO_ROOT, 'scripts')],
];

const byRoot = ROOTS.map(([label, dir]) => ({
  label,
  // Deliberately NOT recursive: nested rigs under `scripts/` are servers and
  // drivers that bind sockets or exit non-zero on import, and they are not on
  // any import path a link break could reach.
  entries: readdirSync(dir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => join(dir, name))
    .sort(),
}));

describe.each(byRoot)('$label', ({ entries }) => {
  test('the root contributed scripts to the sweep', () => {
    // Per-root rather than a total: a root that stops resolving takes its whole
    // contribution with it, and a combined floor would absorb that silently as
    // the other root's script count drifts.
    expect(entries.length).toBeGreaterThan(0);
  });

  test.each(entries.map((path) => [relative(REPO_ROOT, path), path]))(
    '%s links under real node',
    (_label, path) => {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path).href)})`],
        // Under vitest's own `testTimeout`, so a hang fails here and names
        // itself. Measured worst case across the swept set is ~150ms — the eight
        // that reach `ts-morph` — so this is ~130x headroom, sized for a shared
        // CI runner where the fork cap is a no-op rather than for the local run.
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 20_000 },
      );

      // A timeout or spawn failure leaves `status` null and puts the diagnosis
      // here, so read it first — otherwise a hang reports as `expected null to be 0`.
      expect(result.error).toBeUndefined();
      // Surfaced before the exit code so a link break names itself rather than
      // arriving as a bare non-zero. Node's wording is generic, so this covers any
      // missing symbol, not only the one that prompted the guard.
      expect(result.stderr).not.toMatch(/does not provide an export named/);
      // Linking is supposed to be silent. Anything printed means module scope did
      // real work, which under this sweep would run inside a required CI job.
      expect(result.stdout).toBe('');
      // stderr rides along as the assertion message: the checks above name the
      // two failures they were written for, and this one has to speak for every
      // other way a module can fail to load rather than reporting `1 to be 0`.
      expect(result.status, result.stderr || '(no stderr)').toBe(0);
    },
  );
});
