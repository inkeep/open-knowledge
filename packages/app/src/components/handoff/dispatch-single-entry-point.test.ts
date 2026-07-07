/**
 * Regression test — "single outbound dispatch entry point".
 *
 * The ONE outbound-dispatch entry point is `dispatch.ts`.
 *
 * Enforces: every mount surface (EditorHeader, CommandPalette, FileTree, any
 * future surface across `src/` — editor extensions, hooks, presence, lib, etc.)
 * goes through `useHandoffDispatch().dispatch()`. Direct imports of
 * `dispatchHandoff` / `dispatchCursor` / `openExternal` from `@/lib/handoff/*`
 * are ALLOWED only inside the two handoff subpackages (`lib/handoff/**` and
 * `components/handoff/**`) and PROHIBITED everywhere else under
 * `packages/app/src/**`.
 *
 * Scope is `src/`, not just `components/`: a narrower scope would leave
 * `editor/`, `hooks/`, `presence/`, and `lib/` (other than `lib/handoff/`)
 * as silent mount surfaces where a future contributor could bypass
 * `useHandoffDispatch` without any PR-tier signal.
 *
 * Why a text-search test rather than a lint rule: ESLint / Biome have no
 * ergonomic per-directory import allowlist. A Bun test with `readdirSync`
 * + literal `from '@/lib/handoff/...'` substring match gives us the same
 * enforcement in <5 lines per rule, runs in-band with the other fidelity
 * tests, and fails a PR at the exact file that introduced the direct import.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// `import.meta.url` → `…/packages/app/src/components/handoff/…`. Walk up two
// levels to land on `packages/app/src/`, the new scope root.
const SRC_DIR = new URL('../..', import.meta.url).pathname;

/** Subdirectories under `src/` where direct imports of the handoff primitives
 *  are allowlisted — these are the homes of the primitives themselves
 *  (`lib/handoff/`) and the UI hook that routes every mount surface to them
 *  (`components/handoff/`). Paths are `src/`-relative, POSIX-form. */
const ALLOWLISTED_SUBPATHS = ['lib/handoff', 'components/handoff'] as const;

/** Prohibited import substrings — straight string match in source text. */
const PROHIBITED_IMPORT_SUBSTRINGS = [
  "from '@/lib/handoff/dispatch'",
  'from "@/lib/handoff/dispatch"',
  "from '@/lib/handoff/open-external'",
  'from "@/lib/handoff/open-external"',
];

function isAllowlisted(srcRelativePosix: string): boolean {
  return ALLOWLISTED_SUBPATHS.some(
    (sub) => srcRelativePosix === sub || srcRelativePosix.startsWith(`${sub}/`),
  );
}

function listSourceFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const srcRelative = relative(SRC_DIR, full).split(/[\\/]/).join('/');
    if (entry.isDirectory()) {
      if (isAllowlisted(srcRelative)) continue;
      out.push(...listSourceFilesRecursive(full));
    } else {
      if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
      out.push(full);
    }
  }
  return out;
}

describe('AC9: single outbound dispatch entry point — every src directory except handoff subpackages', () => {
  test('packages/app/src/ (excluding lib/handoff + components/handoff) never imports dispatchHandoff / dispatchCursor / openExternal directly', () => {
    // Sanity: the src dir exists and contains real files across multiple
    // sibling dirs (editor/, components/, hooks/, lib/, presence/, server/).
    const stat = statSync(SRC_DIR);
    expect(stat.isDirectory()).toBe(true);
    const files = listSourceFilesRecursive(SRC_DIR);
    expect(files.length).toBeGreaterThan(50); // many files across the tree

    const violations: Array<{ file: string; substring: string }> = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const substring of PROHIBITED_IMPORT_SUBSTRINGS) {
        if (text.includes(substring)) {
          violations.push({ file, substring });
        }
      }
    }

    // Surface a helpful failure message that points at the exact file(s).
    if (violations.length > 0) {
      const lines = violations.map((v) => `  ${v.file} — imports ${v.substring}`);
      throw new Error(
        `AC9 violation — ${violations.length} direct import(s) of handoff dispatch primitives ` +
          `outside the allowlisted subpackages (${ALLOWLISTED_SUBPATHS.join(
            ', ',
          )}). Surfaces must route through useHandoffDispatch().dispatch().\n${lines.join('\n')}`,
      );
    }
  });

  test('components/handoff/ (handoff UI subpackage) is exempt — `@/lib/handoff/…` imports ARE allowed there', () => {
    // Positive assertion: prove the components/handoff/ exemption is
    // load-bearing. If someone deletes its entry from ALLOWLISTED_SUBPATHS,
    // this test surfaces the regression loudly via the negative-assertion
    // test above (components/handoff files would be flagged as violations).
    //
    // lib/handoff/ is intentionally NOT asserted here because its files
    // import peers via relative paths (`./cursor-two-step.ts`, not
    // `@/lib/handoff/cursor-two-step`) — the prohibited-import patterns
    // only match the `@/lib/handoff/…` alias form used by cross-subpackage
    // consumers. The subpackage is exempt by directory; the load-bearing
    // proof for components/handoff/ is sufficient to prove the allowlist
    // mechanism works in general.
    const dir = join(SRC_DIR, 'components/handoff');
    expect(statSync(dir).isDirectory()).toBe(true);
    const files = readdirSync(dir).filter(
      (n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.includes('.test.'),
    );
    const importFound = files.some((name) => {
      const text = readFileSync(join(dir, name), 'utf-8');
      return PROHIBITED_IMPORT_SUBSTRINGS.some((s) => text.includes(s));
    });
    // At least ONE file in components/handoff/ uses the primitives directly
    // (OpenInAgentMenuItem imports openExternal; useHandoffDispatch imports
    // dispatchHandoff). If this ever becomes false we've lost the handoff
    // UI's ability to actually dispatch.
    expect(importFound).toBe(true);
  });

  test('lib/handoff/ (canonical primitive home) is directory-exempt', () => {
    // Sanity: the alias target actually exists. If someone moved the lib
    // home elsewhere without updating ALLOWLISTED_SUBPATHS the negative
    // test above would fire on the new location; this check keeps the
    // surface-area claim observable.
    const dir = join(SRC_DIR, 'lib/handoff');
    expect(statSync(dir).isDirectory()).toBe(true);
    const files = readdirSync(dir).filter(
      (n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.includes('.test.'),
    );
    expect(files.length).toBeGreaterThan(0);
  });
});
