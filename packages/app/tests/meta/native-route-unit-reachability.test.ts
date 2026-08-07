/**
 * Native-route unit-tier reachability guard.
 *
 * The Wave 2 strangler moves route groups out of the legacy dispatch into
 * `http/*-routes.ts` factories mounted natively. In the unit tier, ported
 * routes stay reachable from `ext.onRequest` ONLY through
 * `api-extension.test-helper.ts`, whose wrapper dispatches the native groups
 * before falling through to the legacy hook. A test that imports
 * `createApiExtension` from `./api-extension.ts` directly and requests a
 * ported path exercises the pipeline's `/api/*` 404 fallback instead of the
 * handler — the suite keeps passing while silently asserting nothing about
 * the route it names. With each group lift this failure mode gets quieter
 * and larger, so it is closed mechanically here: base-factory tests may not
 * name natively-owned paths. Fix by importing from the test-helper (routes
 * reach the real handler) or by targeting a deliberately unregistered path
 * with a comment saying so.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');
const HTTP_ROUTES_ROOT = join(SERVER_SRC_ROOT, 'http');

/** Every `'/api/...'` key in any native group's routes record or paths list. */
function collectNativePaths(): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of readdirSync(HTTP_ROUTES_ROOT)) {
    if (!entry.endsWith('-routes.ts') || entry.endsWith('.test.ts')) continue;
    const source = readFileSync(join(HTTP_ROUTES_ROOT, entry), 'utf8');
    for (const match of source.matchAll(/'(\/api\/[^']+)'/g)) {
      const path = match[1] ?? '';
      if (path.endsWith('/*')) {
        // A wildcard claims its namespace: '/api/tags/*' owns '/api/tags/…'.
        prefixes.push(path.slice(0, -1));
      } else {
        exact.add(path);
      }
    }
  }
  return { exact, prefixes };
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

describe('native-route unit-tier reachability', () => {
  test('anti-vacuousness: the native path inventory is non-trivial', () => {
    const { exact, prefixes } = collectNativePaths();
    // Three merged groups own 18 exact paths + the tags wildcard; a scan
    // regression that returns near-zero would mute the guard silently.
    expect(exact.size).toBeGreaterThanOrEqual(15);
    expect(prefixes.length).toBeGreaterThanOrEqual(1);
  });

  test('no base-factory test names a natively-owned path', () => {
    const { exact, prefixes } = collectNativePaths();
    const offenders: string[] = [];
    for (const file of listServerTestFiles()) {
      const source = readFileSync(file, 'utf8');
      if (!importsBaseFactory(source)) continue;
      for (const match of source.matchAll(/'(\/api\/[^'?]+)/g)) {
        const path = match[1] ?? '';
        const owned = exact.has(path) || prefixes.some((prefix) => path.startsWith(prefix));
        if (!owned) continue;
        const line = source.slice(0, match.index ?? 0).split('\n').length;
        offenders.push(
          `${file}:${line} — requests natively-owned '${path}' through the BASE createApiExtension ` +
            '(the legacy table 404s it; the handler never runs). Import from ' +
            "'./api-extension.test-helper.ts' instead, or target a legacy-owned path.",
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
