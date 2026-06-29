
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_DIR = new URL('../..', import.meta.url).pathname;

/** Subdirectories under `src/` where direct imports of the handoff primitives
 *  are allowlisted — these are the homes of the primitives themselves
 *  (`lib/handoff/`) and the UI hook that routes every mount surface to them
 *  (`components/handoff/`). Paths are `src/`-relative, POSIX-form. */
const ALLOWLISTED_SUBPATHS = ['lib/handoff', 'components/handoff'] as const;

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
    const dir = join(SRC_DIR, 'components/handoff');
    expect(statSync(dir).isDirectory()).toBe(true);
    const files = readdirSync(dir).filter(
      (n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.includes('.test.'),
    );
    const importFound = files.some((name) => {
      const text = readFileSync(join(dir, name), 'utf-8');
      return PROHIBITED_IMPORT_SUBSTRINGS.some((s) => text.includes(s));
    });
    expect(importFound).toBe(true);
  });

  test('lib/handoff/ (canonical primitive home) is directory-exempt', () => {
    const dir = join(SRC_DIR, 'lib/handoff');
    expect(statSync(dir).isDirectory()).toBe(true);
    const files = readdirSync(dir).filter(
      (n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.includes('.test.'),
    );
    expect(files.length).toBeGreaterThan(0);
  });
});
