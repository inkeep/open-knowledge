/**
 * Version-pin guard for copy-out-of-the-nested-CodeMirror-box behavior.
 *
 * Why a version pin and not a browser E2E:
 *
 * A real-browser probe copied a sub-selection out of an unregistered
 * component's nested rawMdxFallback CodeMirror box and observed that the
 * clipboard is POPULATED — the ProseMirror #1068
 * empty-clipboard-under-mouse-focus class does not reproduce here, even
 * though the outer ProseMirror holds a NodeSelection on the raw box while the
 * selection lives inside the nested editable (the exact #1068 topology).
 *
 * The behavior is owned entirely by third-party code: CodeMirror's own copy
 * handler writes the sub-selection to `text/plain`, and prosemirror-view's DOM
 * copy handler declines to overwrite it. No Open-Knowledge-owned lever
 * reproduces the empty-clipboard class — flipping the raw box NodeView's
 * `stopEvent` does not change the outcome. A browser E2E asserting "clipboard
 * populated" would therefore be non-falsifiable by any in-repo regression, and
 * the exact copied text is word-wrap-dependent (visual-line selection), so an
 * exact-string assertion would flake. Both make such an E2E a permanently-
 * green smoke check rather than a guard.
 *
 * What genuinely gates the observed-good behavior is the resolved version of
 * the two packages that own the copy handlers: prosemirror-view (transitive
 * via @tiptap/pm — no direct dep to bump) and @codemirror/view (direct dep).
 * This guard floors both at the versions the probe verified. A downgrade below
 * either — e.g. a @tiptap/pm bump that pulls an older prosemirror-view, or a
 * @codemirror/view downgrade — trips the guard so someone re-runs the browser
 * probe before shipping. Forward drift within the floor passes untouched.
 *
 * This follows the same resolve-and-assert shape other version-floor guards
 * in the repo use.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Versions the nested-box copy behavior was verified working at. A resolved
 * version below any of these means the copy-handler ownership may have shifted
 * — re-run the browser probe (select inside `.raw-mdx-fallback-wrapper
 * .cm-content`, copy, confirm `text/plain` is populated) before raising them.
 */
// The floor equals the exact resolved versions, so it has zero headroom: an
// unrelated transitive-dep bump can trip it with no direct-dep fix (re-run the
// browser probe to re-baseline).
const VERIFIED_FLOOR = {
  'prosemirror-view': '1.41.8',
  '@codemirror/view': '6.41.0',
} as const;

const require_ = createRequire(import.meta.url);

function resolvedVersion(pkg: string): string {
  // Node's strict exports resolver rejects a bare `<pkg>/package.json` subpath
  // unless the package lists it in `exports` (bun resolves it leniently).
  // Resolve the package's main entry (always exported) and walk up to the
  // owning package.json instead.
  let dir = dirname(require_.resolve(pkg));
  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === pkg && parsed.version) return parsed.version;
    } catch {
      // no package.json here (or a nested one without the matching name) — walk up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not resolve package.json for ${pkg}`);
    dir = parent;
  }
}

/** Return true when `actual` is >= `floor` by numeric major.minor.patch order. */
function meetsFloor(actual: string, floor: string): boolean {
  const toParts = (v: string): number[] =>
    v
      .split('-')[0] // drop any prerelease suffix
      .split('.')
      .map((n) => Number.parseInt(n, 10));
  const a = toParts(actual);
  const f = toParts(floor);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const fv = f[i] ?? 0;
    if (av !== fv) return av > fv;
  }
  return true; // equal
}

describe('nested rawMdxFallback copy — third-party copy-handler version floor', () => {
  for (const [pkg, floor] of Object.entries(VERIFIED_FLOOR)) {
    test(`${pkg} resolves at or above the probe-verified ${floor}`, () => {
      const actual = resolvedVersion(pkg);
      expect(meetsFloor(actual, floor)).toBe(true);
    });
  }
});
