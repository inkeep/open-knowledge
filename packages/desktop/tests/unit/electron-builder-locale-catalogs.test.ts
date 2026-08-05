import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { resolveMenuCatalogDir } from '../../src/main/main-i18n.ts';

/**
 * The packaged `.app` must ship the compiled message catalogs where the main
 * process expects to find them, or every menu label falls back to English in a
 * build nobody runs before release.
 *
 * The renderer's catalogs already ride `../cli/dist/public` — but bundled into
 * JS chunks, unreadable as files. Main needs the raw `messages.json`, so this
 * is a second, deliberate copy of the same data rather than an oversight.
 *
 * Two halves are checked, because either alone passes while the feature is
 * broken: the rule exists AND its `to:` is the directory `resolveMenuCatalogDir`
 * reads on the packaged branch.
 */

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
    // A `**/*` filter would ship the translator-facing `.po` files too —
    // several times the bytes, and nothing reads them at runtime.
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
