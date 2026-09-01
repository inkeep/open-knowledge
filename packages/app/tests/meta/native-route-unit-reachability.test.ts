import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  extractRouteHandlerNames,
  listNativeRouteFiles,
} from '../native-route-files.test-helper.ts';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');

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
        prefixes.push(path.slice(0, -1));
      } else if (path.endsWith('/')) {
        prefixes.push(path);
      } else if (path.includes('/:')) {
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

function importsBaseFactory(source: string): boolean {
  return /import\s*\{[^}]*\bcreateApiExtension\b[^}]*\}\s*from\s*'[^']*\/api-extension\.ts'/.test(
    source,
  );
}

function usesLegacyOnlySeam(source: string): boolean {
  if (importsBaseFactory(source)) return true;
  const importsServerFactory =
    /import\s*\{[^}]*\bcreateServer\b[^}]*\}\s*from\s*'[^']*\/server-factory\.ts'/.test(source);
  return importsServerFactory && !source.includes('nativeApi.dispatch');
}

describe('native-route unit-tier reachability', () => {
  test('anti-vacuousness: every route file contributes paths and the inventory is non-trivial', () => {
    const { exact, prefixes, perFile } = collectNativePaths();
    for (const [file, count] of perFile) {
      expect(count, `${file} contributes no '/api/...' paths — scan regression?`).toBeGreaterThan(
        0,
      );
    }
    expect(exact.size).toBeGreaterThanOrEqual(45);
    expect(new Set(prefixes).size).toBeGreaterThanOrEqual(2);
  });

  test('the discovered route files and the extension mounts are the same set', () => {
    const ext = readFileSync(join(SERVER_SRC_ROOT, 'api-extension.ts'), 'utf8');
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
      const remedy = importsBaseFactory(source)
        ? "Import from './api-extension.test-helper.ts' instead"
        : 'Dispatch `nativeApi.dispatch` ahead of the legacy onRequest';
      for (const match of source.matchAll(/['`](\/api\/[^'`?$]+)/g)) {
        const path = match[1] ?? '';
        const owned = exact.has(path) || prefixes.some((prefix) => path.startsWith(prefix));
        if (!owned) continue;
        const upToMatch = source.slice(0, match.index ?? 0);
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
    for (const file of ['api-extension.ts', ...listNativeRouteFiles(SERVER_SRC_ROOT)]) {
      const names = extractRouteHandlerNames(readFileSync(join(SERVER_SRC_ROOT, file), 'utf8'));
      expect(
        names.length,
        `${file} contributes no route-record handler names — extractor blind to its record shape?`,
      ).toBeGreaterThan(0);
    }
  });
});
