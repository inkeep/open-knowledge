import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('package export conditions', () => {
  test.each([
    ['@inkeep/open-knowledge-server', '../package.json'],
    ['@inkeep/open-knowledge-core', '../../core/package.json'],
  ])(
    '%s keeps every export subpath on the same four conditions in the same order',
    (_name, rel) => {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, rel), 'utf8')) as {
        exports: Record<string, Record<string, string>>;
      };
      const subpaths = Object.entries(pkg.exports);
      expect(subpaths.length).toBeGreaterThan(0);
      for (const [subpath, entry] of subpaths) {
        expect(Object.keys(entry), `${rel} ${subpath} condition order`).toEqual([
          '@inkeep/source',
          'development',
          'types',
          'default',
        ]);
        expect(entry['@inkeep/source'], `${rel} ${subpath} source vs development`).toBe(
          entry.development,
        );
        expect(entry.types, `${rel} ${subpath} types must resolve to a declaration`).toMatch(
          /\.d\.mts$/,
        );
      }
    },
  );
});
