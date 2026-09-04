import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { resolveMenuCatalogDir } from '../../src/main/main-i18n.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');

function localeRule(): { from?: unknown; to?: unknown; filter?: unknown } | undefined {
  const config = parse(readFileSync(builderYml, 'utf8')) as {
    extraResources?: Array<{ from?: unknown; to?: unknown; filter?: unknown }>;
  };
  return (config.extraResources ?? []).find((rule) => rule.from === '../app/src/locales');
}

describe('electron-builder.yml ships the compiled catalogs to packaged main', () => {
  test('extraResources declares a ../app/src/locales rule', () => {
    expect(
      localeRule(),
      'Without this rule the packaged main process finds no catalogs and the native menu bar ' +
        'renders English in every language — see main-i18n.ts.',
    ).toBeDefined();
  });

  test('the rule lands where resolveMenuCatalogDir looks on the packaged branch', () => {
    const packagedDir = resolveMenuCatalogDir({
      isPackaged: true,
      resourcesPath: '/R',
      mainDir: '/R/app.asar/out/main',
    });
    expect(`/R/${String(localeRule()?.to)}`).toBe(packagedDir);
  });

  test('the filter admits messages.json and excludes the .po sources', () => {
    const filter = localeRule()?.filter;
    expect(Array.isArray(filter)).toBe(true);
    const patterns = filter as string[];
    expect(patterns).toContain('**/messages.json');
    expect(patterns.some((p) => p === '**/*' || p.endsWith('.po'))).toBe(false);
  });

  test('every supported locale has a compiled catalog to copy at build time', () => {
    const source = resolve(desktopRoot, '..', 'app', 'src', 'locales');
    const missing = SUPPORTED_LOCALES.filter(
      (locale) => !existsSync(resolve(source, locale, 'messages.json')),
    );
    expect(missing).toEqual([]);
  });
});
