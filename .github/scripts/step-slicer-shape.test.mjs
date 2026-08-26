/**
 * A ratchet over the workflow-slicing shape these script tests use to scope an
 * assertion to one step.
 *
 * The hazard is narrow and has bitten repeatedly. `src.slice(src.indexOf(x))`
 * returns the file's LAST CHARACTER when `x` is absent, because `indexOf`
 * yields -1 and `slice(-1)` counts from the end. A test whose assertions are
 * `not.toContain` / `not.toMatch` then passes against that one character — so
 * renaming or moving the step it guards turns its own coverage green instead of
 * red, which is the one failure a ratchet must never have.
 *
 * Two live instances were found this way, not by review:
 *   - `a blocked release never pages Discord` stayed green while its step was
 *     renamed, in a file whose module docstring calls that test "the ratchet".
 *   - `the refusal page does not claim a cause it has not established` had a
 *     single negative assertion over an unguarded slice.
 *
 * The safe form binds the index first and refuses -1, either by throwing (in a
 * helper) or with `expect(i).toBeGreaterThan(-1)` (inline):
 *
 *   const at = src.indexOf('- name: X');
 *   if (at === -1) throw new Error('no "- name: X" step');
 *   const step = src.slice(at);
 *
 * BASELINE, not a clean sweep. The counts below freeze the sites that predate
 * this test; they are mostly two-argument slices followed by positive
 * assertions, which already fail loudly on a degenerate scope. That protection
 * is incidental — assertion ordering rather than structure — so the numbers are
 * a backlog to drive DOWN, never up. Converting them all onto one shared
 * guarded helper is the real fix and belongs in its own change.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const SELF_PATH = fileURLToPath(import.meta.url);
const HERE = dirname(SELF_PATH);

/**
 * Both roots `vitest.scripts.config.ts` collects, not just this one. A
 * workflow-slicing test can land in either, and a ratchet that guards only the
 * directory it was written in is how the shape spreads to the other.
 */
const ROOTS = [HERE, join(HERE, '..', '..', 'scripts')];

/**
 * An `indexOf` nested directly inside the `slice` that consumes it — matched
 * source-wide rather than per line, because the argument list routinely wraps.
 * The guarded form binds the index to a variable first, so it never matches.
 *
 * The receiver may be a member chain (`o.src.indexOf`), not just a bare
 * identifier, and the finder may be `lastIndexOf`: both return -1 on absence,
 * so both carry the identical hazard and a narrower pattern lets a spelling of
 * it through.
 */
const NESTED_SLICE = /\.slice\(\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.(?:indexOf|lastIndexOf)\(/g;

/** Sites that predate this ratchet. Lower these; never raise them. */
const BASELINE = {
  'build-smoke-alert-payload.test.mjs': 3,
  'point-release-plan.test.mjs': 1,
  'release-cascade-shape.test.mjs': 18,
};

const countIn = (src) => [...src.matchAll(NESTED_SLICE)].length;

/**
 * This file is excluded from its own scan: the header documents the banned form
 * and the regex pin below quotes it, so it matches by construction.
 *
 * Scope is `.test.mjs` across both roots — deliberately not the production
 * `.mjs` siblings. The hazard being ratcheted is a TEST that passes against a
 * one-character slice; production code that slices the same way fails visibly
 * instead. (`point-release-plan.mjs` does carry the shape, harmlessly: its
 * trailing `+ 1` turns a miss into `slice(0)` rather than `slice(-1)`.)
 */
const SELF = basename(SELF_PATH);

/** Every scanned file as `[label, absolute path]`, label unique across roots. */
const scanTargets = () =>
  ROOTS.flatMap((root) =>
    readdirSync(root)
      .filter((f) => f.endsWith('.test.mjs') && f !== SELF)
      .map((f) => [f, join(root, f)]),
  );

describe('unguarded step-slicer shape', () => {
  const targets = scanTargets();
  const files = targets.map(([label]) => label);

  test('the scanner finds both script roots and their test files', () => {
    // Without this the whole ratchet passes vacuously if a glob ever breaks —
    // the exact defect it exists to catch, one level up.
    expect(files.length).toBeGreaterThan(30);
    for (const root of ROOTS) {
      expect(
        readdirSync(root).filter((f) => f.endsWith('.test.mjs')).length,
        `${root}: no .test.mjs files found`,
      ).toBeGreaterThan(0);
    }
    expect(readdirSync(HERE)).toContain(SELF);
  });

  test('the pattern matches the unguarded form and not the guarded one', () => {
    // Pins the regex itself. A pattern that matched nothing would make every
    // count below zero and the ratchet silently permissive.
    expect(countIn("const s = src.slice(src.indexOf('- name: X'));")).toBe(1);
    expect(countIn('const s = src.slice(\n  src.indexOf(a),\n  src.indexOf(b),\n);')).toBe(1);
    // A member-chain receiver and lastIndexOf are the same hazard, so both
    // must match too.
    expect(countIn("const s = o.src.slice(o.src.indexOf('- name: X'));")).toBe(1);
    expect(countIn("const s = src.slice(src.lastIndexOf('x'));")).toBe(1);
    expect(countIn("const s = ctx.source.slice(ctx.source.lastIndexOf('x'));")).toBe(1);
    expect(countIn("const at = src.indexOf('x');\nconst s = src.slice(at);")).toBe(0);
    expect(countIn('const s = src.slice(0, 40);')).toBe(0);
  });

  test('no new file introduces the unguarded shape', () => {
    const offenders = targets
      .filter(([label]) => !(label in BASELINE))
      .filter(([, path]) => countIn(readFileSync(path, 'utf8')) > 0)
      .map(([label]) => label);
    expect(
      offenders,
      "bind the index and refuse -1 before slicing; see this file's header for the safe form",
    ).toEqual([]);
  });

  test('every baselined file carries exactly its baselined count', () => {
    // EXACT, not a ceiling. `<=` would let the scanner go blind — a broken read
    // or a pattern that stops matching drops every count to 0, and 0 <= 19
    // passes silently. That is one of the self-vacuity modes this file claims to
    // close, so it must not be the one left open. The cost is that removing a
    // site means lowering the number in the same commit, which is the point:
    // the backlog only moves deliberately.
    for (const [file, allowed] of Object.entries(BASELINE)) {
      const target = targets.find(([label]) => label === file);
      expect(target, `${file}: baselined but not found in either script root`).toBeDefined();
      const found = countIn(readFileSync(target[1], 'utf8'));
      expect(
        found,
        `${file}: ${found} unguarded slice(indexOf(...)) sites, baseline ${allowed}. ` +
          'Lower the baseline in the same commit when you remove one; never raise it to add one.',
      ).toBe(allowed);
    }
  });

  test('the baseline names only files that still exist', () => {
    // A stale entry would silently excuse a file that had been renamed.
    for (const file of Object.keys(BASELINE)) expect(files).toContain(file);
  });
});
