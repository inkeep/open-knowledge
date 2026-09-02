import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';

const VERIFIED_FLOOR = {
  'prosemirror-view': '1.41.8',
  '@codemirror/view': '6.41.0',
} as const;

const require_ = createRequire(import.meta.url);

function resolvedVersion(pkg: string): string {
  let dir = dirname(require_.resolve(pkg));
  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === pkg && parsed.version) return parsed.version;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not resolve package.json for ${pkg}`);
    dir = parent;
  }
}

function meetsFloor(actual: string, floor: string): boolean {
  const toParts = (v: string): number[] =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10));
  const a = toParts(actual);
  const f = toParts(floor);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const fv = f[i] ?? 0;
    if (av !== fv) return av > fv;
  }
  return true;
}

describe('nested rawMdxFallback copy — third-party copy-handler version floor', () => {
  for (const [pkg, floor] of Object.entries(VERIFIED_FLOOR)) {
    test(`${pkg} resolves at or above the probe-verified ${floor}`, () => {
      const actual = resolvedVersion(pkg);
      expect(meetsFloor(actual, floor)).toBe(true);
    });
  }
});
