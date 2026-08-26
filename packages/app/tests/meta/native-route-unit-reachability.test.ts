/**
 * Native-route unit-tier reachability guard.
 *
 * The Wave 2 strangler moves route groups out of the legacy dispatch into
 * `http/*-routes.ts` factories mounted natively. In the unit tier, ported
 * routes are reachable only through a seam that dispatches the native groups
 * ahead of the legacy hook: `api-extension.test-helper.ts`'s wrapper, or a
 * `createServer` harness that runs `nativeApi.dispatch` before its own
 * `onRequest` loop. A test that drives `/api/*` through a legacy-only seam —
 * the BASE `createApiExtension` import, or a hand-rolled `createServer`
 * HTTP/`onRequest` harness — and requests a ported path exercises the
 * pipeline's `/api/*` 404 fallback instead of the handler; the suite keeps
 * passing while silently asserting nothing about the route it names. With
 * each group lift this failure mode gets quieter and larger, so it is closed
 * mechanically here for BOTH seams. Fix a base-factory offender by importing
 * from the test-helper, a `createServer` harness by dispatching
 * `nativeApi.dispatch` first, or target a legacy-owned path.
 *
 * This file also hosts two contracts for the guard family itself: the
 * route-record extraction floor for the three registry cross-check guards
 * (they each carried a private copy; one copy here keeps the assertion
 * single-sourced in the directory whose tests need no coverage tags), and
 * the discovery/mount set equality that keeps `listNativeRouteFiles` — the
 * discovered slice of the guards' scan surfaces (several also hand-list
 * extra sources such as `api-extension.ts`) — in lockstep with the factory
 * mounts in `api-extension.ts`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  extractRouteHandlerNames,
  listNativeRouteFiles,
} from '../native-route-files.test-helper.ts';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');

/** Every `'/api/...'` key in any native group's routes record or paths list, per file. */
function collectNativePaths(): {
  exact: Set<string>;
  prefixes: string[];
  perFile: Map<string, number>;
} {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  const perFile = new Map<string, number>();
  for (const entry of listNativeRouteFiles(SERVER_SRC_ROOT)) {
    const source = readFileSync(join(SERVER_SRC_ROOT, entry), 'utf8');
    let count = 0;
    for (const match of source.matchAll(/'(\/api\/[^']+)'/g)) {
      const path = match[1] ?? '';
      count += 1;
      if (path.endsWith('/*')) {
        // A wildcard claims its namespace: '/api/tags/*' owns '/api/tags/…'.
        prefixes.push(path.slice(0, -1));
      } else if (path.endsWith('/')) {
        // A `createApiRouteGroup` dynamic-leg `prefix:` ('/api/tags/') — the
        // wildcard path is built at runtime, so the prefix literal is the
        // namespace claim the source scan sees.
        prefixes.push(path);
      } else if (path.includes('/:')) {
        // A dynamic-leg `template:` ('/api/tags/:name') — the namespace is
        // already claimed by its prefix; the template is not a requestable path.
      } else {
        exact.add(path);
      }
    }
    perFile.set(entry, count);
  }
  return { exact, prefixes, perFile };
}

function listServerTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && entry.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(SERVER_SRC_ROOT);
  return out;
}

/** True when the file imports `createApiExtension` from the BASE module. */
function importsBaseFactory(source: string): boolean {
  return /import\s*\{[^}]*\bcreateApiExtension\b[^}]*\}\s*from\s*'[^']*\/api-extension\.ts'/.test(
    source,
  );
}

/**
 * True when the file drives `/api/*` through a seam that skips the native
 * mount. Two construction paths produce that seam: the BASE
 * `createApiExtension` import, and a `createServer` harness that hand-rolls
 * its own HTTP/`onRequest` loop. A `createServer` harness is exempt once it
 * dispatches `nativeApi.dispatch` first (the production order) — the
 * property being protected is "ported paths reach their real handler", not
 * which import the file happens to use.
 */
function usesLegacyOnlySeam(source: string): boolean {
  if (importsBaseFactory(source)) return true;
  const importsServerFactory =
    /import\s*\{[^}]*\bcreateServer\b[^}]*\}\s*from\s*'[^']*\/server-factory\.ts'/.test(source);
  // The exemption is what makes a `createServer` harness production-shaped;
  // note it is FILE-scoped — one native-first driver exempts every driver in
  // the file.
  return importsServerFactory && !source.includes('nativeApi.dispatch');
}

describe('native-route unit-tier reachability', () => {
  test('anti-vacuousness: every route file contributes paths and the inventory is non-trivial', () => {
    const { exact, prefixes, perFile } = collectNativePaths();
    // Structural, so the floor scales with the inventory it protects: a scan
    // regression that silently drops a whole group's paths reddens here, not
    // just a near-zero collapse. Nine merged groups own 51 exact paths + 2
    // dynamic namespaces at the time of writing; the two numeric floors are
    // group-sized backstops (they drift as groups land), and file-set
    // coverage is owned by the mount equality below rather than a
    // hand-recalibrated count.
    for (const [file, count] of perFile) {
      expect(count, `${file} contributes no '/api/...' paths — scan regression?`).toBeGreaterThan(
        0,
      );
    }
    expect(exact.size).toBeGreaterThanOrEqual(45);
    expect(new Set(prefixes).size).toBeGreaterThanOrEqual(2);
  });

  test('the discovered route files and the extension mounts are the same set', () => {
    // Set-shaped in BOTH directions, so no integer needs recalibrating as
    // groups come and go. Discovered-not-mounted: usually a dead file (or a
    // group mounted somewhere other than `api-extension.ts`, the only file
    // read here). Mounted-not-discovered: usually a group whose filename
    // left the `-routes.ts` glob, which silently drops it from every guard
    // keyed on `listNativeRouteFiles` — the per-file floors above cannot see
    // that, because they only visit what discovery returned. The diagnoses
    // are not exclusive: the `http/<kebab>-routes.ts` ⇒ `create<Pascal>Routes`
    // naming convention is what joins the two sides, so a one-sided rename
    // of a live group trips BOTH directions and the fix is the rename.
    const ext = readFileSync(join(SERVER_SRC_ROOT, 'api-extension.ts'), 'utf8');
    // `=\s*` requires an assignment site, so a bare prose mention of a
    // factory name cannot register as a mount (a commented-out assignment
    // still would; the import lines never match because they carry no call
    // paren).
    const mounted = [...ext.matchAll(/=\s*create(\w+)Routes\(/g)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
    const discovered = listNativeRouteFiles(SERVER_SRC_ROOT).map((file) =>
      file
        .replace('http/', '')
        .replace('-routes.ts', '')
        .split('-')
        .map((seg) => (seg[0] ?? '').toUpperCase() + seg.slice(1))
        .join(''),
    );
    expect(
      [...new Set(mounted)].sort(),
      'mounted (received) vs discovered (expected) name sets diverged — map the diff back to a file/factory via the divergence taxonomy in the comment above this assertion',
    ).toEqual([...new Set(discovered)].sort());
  });

  test('no legacy-only test seam names a natively-owned path', () => {
    const { exact, prefixes } = collectNativePaths();
    const offenders: string[] = [];
    for (const file of listServerTestFiles()) {
      const source = readFileSync(file, 'utf8');
      if (!usesLegacyOnlySeam(source)) continue;
      // Bind the remedy to the seam that fired: a base-factory import swaps
      // to the test-helper; a hand-rolled `createServer` harness dispatches
      // the native groups first.
      const remedy = importsBaseFactory(source)
        ? "Import from './api-extension.test-helper.ts' instead"
        : 'Dispatch `nativeApi.dispatch` ahead of the legacy onRequest';
      // Both quote styles: template literals are how query-carrying requests
      // are usually built (`/api/search?query=${q}`), and one slipped through
      // the single-quote-only scan.
      for (const match of source.matchAll(/['`](\/api\/[^'`?$]+)/g)) {
        const path = match[1] ?? '';
        const owned = exact.has(path) || prefixes.some((prefix) => path.startsWith(prefix));
        if (!owned) continue;
        const upToMatch = source.slice(0, match.index ?? 0);
        // Comment prose (docblocks narrating a trigger) is not a request —
        // only literals in live code can produce the vacuous 404.
        const lineText = upToMatch.slice(upToMatch.lastIndexOf('\n') + 1).trimStart();
        if (lineText.startsWith('*') || lineText.startsWith('//') || lineText.startsWith('/*')) {
          continue;
        }
        const line = upToMatch.split('\n').length;
        offenders.push(
          `${file}:${line} — requests natively-owned '${path}' through a legacy-only seam ` +
            `(the legacy table 404s it; the handler never runs). ${remedy}, ` +
            'or target a legacy-owned path.',
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('route-record extraction floor', () => {
  test('every route-record source contributes handler names to the registry guards', () => {
    // The registry cross-checks (error-envelope / attribution-sweep /
    // conflict-gate) extract `'/api/…': handleX` bindings per source; a
    // source contributing zero names means the extractor went blind to its
    // record shape and the guards shrink silently. `api-extension.ts` is the
    // majority contributor while the legacy record drains — when a group lift
    // finally empties it, remove it from this list in the same PR.
    // `skills-sh-handlers.ts` is scanned by the guards but owns no record of
    // its own (its record lives in `skills-sh-routes.ts`), so it is not
    // floored here.
    for (const file of ['api-extension.ts', ...listNativeRouteFiles(SERVER_SRC_ROOT)]) {
      const names = extractRouteHandlerNames(readFileSync(join(SERVER_SRC_ROOT, file), 'utf8'));
      expect(
        names.length,
        `${file} contributes no route-record handler names — extractor blind to its record shape?`,
      ).toBeGreaterThan(0);
    }
  });
});
