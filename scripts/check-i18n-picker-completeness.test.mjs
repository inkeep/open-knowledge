import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  formatCoverageTable,
  formatShortfalls,
  measureCoverage,
  readPickerLocales,
} from './check-i18n-picker-completeness.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCALES_TS = join(OK_ROOT, 'packages/core/src/i18n/locales.ts');

const catalogOf = (entries) => new Map(Object.entries(entries));

describe('picker enumeration', () => {
  const picker = readPickerLocales(readFileSync(LOCALES_TS, 'utf8'));

  test('reads the offered set out of core rather than restating it', () => {
    expect(picker.length).toBeGreaterThan(0);
    expect(picker).toContain('en');
    expect(picker.filter((tag) => Intl.getCanonicalLocales(tag)[0] !== tag)).toEqual([]);
  });

  test('reads a tuple spread across lines, which is how core writes it', () => {
    expect(
      readPickerLocales(
        ["export const PICKER_LOCALES = [", "  'en',", "  'zh-Hans',", '] as const;'].join('\n'),
      ),
    ).toEqual(['en', 'zh-Hans']);
  });

  test('refuses a source it cannot find the tuple in', () => {
    expect(() => readPickerLocales("export const SUPPORTED_LOCALES = ['en'];")).toThrow(
      /PICKER_LOCALES/,
    );
  });

  test('refuses an empty tuple rather than reporting zero locales to gate', () => {
    expect(() => readPickerLocales('export const PICKER_LOCALES = [] as const;')).toThrow(/empty/);
  });
});

describe('coverage measurement', () => {
  const source = catalogOf({ Save: 'Save', Cancel: 'Cancel', Delete: 'Delete' });

  test('counts a fully translated catalog as complete', () => {
    const result = measureCoverage({
      locale: 'es',
      sourceMessages: source,
      catalog: catalogOf({ Save: 'Guardar', Cancel: 'Cancelar', Delete: 'Eliminar' }),
    });
    expect(result).toMatchObject({ total: 3, translated: 3, untranslated: [] });
  });

  test('names the untranslated messages rather than only counting them', () => {
    const result = measureCoverage({
      locale: 'es',
      sourceMessages: source,
      catalog: catalogOf({ Save: 'Guardar', Cancel: '', Delete: '   ' }),
    });
    expect(result.translated).toBe(1);
    expect(result.untranslated).toEqual(['Cancel', 'Delete']);
  });

  test('treats a message absent from the catalog as untranslated', () => {
    const result = measureCoverage({
      locale: 'es',
      sourceMessages: source,
      catalog: catalogOf({ Save: 'Guardar' }),
    });
    expect(result.untranslated).toEqual(['Cancel', 'Delete']);
  });

  test('reports a missing catalog rather than dividing by an absent one', () => {
    const result = measureCoverage({ locale: 'es', sourceMessages: source, catalog: undefined });
    expect(result).toMatchObject({ missingCatalog: true, translated: 0 });
  });

  test('the source locale is complete without inspecting its msgstr', () => {
    const result = measureCoverage({
      locale: 'en',
      sourceMessages: source,
      catalog: catalogOf({ Save: '', Cancel: '', Delete: '' }),
      isSource: true,
    });
    expect(result).toMatchObject({ total: 3, translated: 3, untranslated: [] });
  });
});

describe('plural completeness', () => {
  const source = catalogOf({
    '{n, plural, one {# file} other {# files}}': '{n, plural, one {# file} other {# files}}',
  });

  test("accepts a translation carrying its own locale's categories", () => {
    const result = measureCoverage({
      locale: 'es',
      sourceMessages: source,
      catalog: catalogOf({
        '{n, plural, one {# file} other {# files}}':
          '{n, plural, one {# archivo} many {# archivos} other {# archivos}}',
      }),
    });
    expect(result.pluralGaps).toEqual([]);
  });

  test('flags a translation that reuses the English category set', () => {
    const result = measureCoverage({
      locale: 'es',
      sourceMessages: source,
      catalog: catalogOf({
        '{n, plural, one {# file} other {# files}}':
          '{n, plural, one {# archivo} other {# archivos}}',
      }),
    });
    expect(result.pluralGaps).toEqual([
      { id: '{n, plural, one {# file} other {# files}}', missing: ['many'] },
    ]);
  });

  test('accepts a single category for a locale that only has one', () => {
    const result = measureCoverage({
      locale: 'zh-Hans',
      sourceMessages: source,
      catalog: catalogOf({
        '{n, plural, one {# file} other {# files}}': '{n, plural, other {# 个文件}}',
      }),
    });
    expect(result.pluralGaps).toEqual([]);
  });
});

describe('reporting', () => {
  test('the coverage table lists every enumerated locale, not only the gated ones', () => {
    const table = formatCoverageTable([
      { locale: 'en', total: 10, translated: 10, gated: true },
      { locale: 'es', total: 10, translated: 10, gated: true },
      { locale: 'ar', total: 10, translated: 3, gated: false },
    ]);
    expect(table).toMatch(/\ben\b/);
    expect(table).toMatch(/\bes\b/);
    expect(table).toMatch(/\bar\b/);
    expect(table).toMatch(/30%/);
  });

  test('a shortfall names the locale and how much is missing', () => {
    const report = formatShortfalls([
      { locale: 'es', total: 10, translated: 7, untranslated: ['a', 'b', 'c'], pluralGaps: [] },
    ]);
    expect(report).toMatch(/es/);
    expect(report).toMatch(/3 untranslated/);
  });

  test('a plural shortfall names the missing categories', () => {
    const report = formatShortfalls([
      {
        locale: 'es',
        total: 1,
        translated: 1,
        untranslated: [],
        pluralGaps: [{ id: '{n, plural, …}', missing: ['many'] }],
      },
    ]);
    expect(report).toMatch(/many/);
  });
});

describe('the gate against the real catalogs', () => {
  test('passes on the committed catalogs', () => {
    const result = spawnSync('node', ['scripts/check-i18n-picker-completeness.mjs'], {
      cwd: OK_ROOT,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).toMatch(/zh-Hans/);
    expect(result.status).toBe(0);
  });
});
