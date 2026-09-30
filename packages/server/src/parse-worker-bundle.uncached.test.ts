import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import cliConfig from '../../cli/tsdown.config';
import serverConfig from '../tsdown.config';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('worker entry ships in every bundle shape', () => {
  test('server tsdown config emits the parse-worker entry', () => {
    expect(serverConfig.entry).toMatchObject({ 'parse-worker': 'src/parse-worker.ts' });
  });

  test('cli tsdown config emits the parse-worker entry next to dist/cli.mjs', () => {
    const standalone = cliConfig.find(
      (config) =>
        typeof config.entry === 'object' &&
        config.entry !== null &&
        Object.hasOwn(config.entry, 'cli'),
    );
    expect(standalone?.entry).toMatchObject({
      cli: 'src/cli.ts',
      'parse-worker': 'src/parse-worker.ts',
    });
  });

  test('server package.json exports the parse-worker subpath for both conditions', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(pkg.exports['./parse-worker']).toEqual({
      '@inkeep/source': './src/parse-worker.ts',
      development: './src/parse-worker.ts',
      types: './dist/parse-worker.d.mts',
      default: './dist/parse-worker.mjs',
    });
  });

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
