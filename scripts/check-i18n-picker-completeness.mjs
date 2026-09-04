#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePoCatalog,
  pluralSelectorsIn,
  readSupportedLocales,
  requiredPluralCategories,
  SOURCE_LOCALE,
} from './check-i18n-new-string-translations.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCALES_TS = 'packages/core/src/i18n/locales.ts';
const CATALOG_REL = (locale) => `packages/app/src/locales/${locale}/messages.po`;

export function readPickerLocales(source) {
  const block = /export const PICKER_LOCALES\s*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!block) {
    throw new Error(`Could not find a PICKER_LOCALES array in ${LOCALES_TS}`);
  }
  const tags = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (tags.length === 0) {
    throw new Error(`PICKER_LOCALES in ${LOCALES_TS} parsed as empty`);
  }
  return tags;
}

export function measureCoverage({ locale, sourceMessages, catalog, isSource = false }) {
  const total = sourceMessages.size;
  if (isSource) {
    return { locale, total, translated: total, untranslated: [], pluralGaps: [] };
  }
  if (!catalog) {
    return { locale, total, translated: 0, untranslated: [], pluralGaps: [], missingCatalog: true };
  }

  const required = requiredPluralCategories(locale);
  const untranslated = [];
  const pluralGaps = [];

  for (const [id, sourceText] of sourceMessages) {
    const translation = catalog.get(id);
    if (!translation || translation.trim() === '') {
      untranslated.push(id);
      continue;
    }
    if (pluralSelectorsIn(sourceText || id).size > 0) {
      const declared = pluralSelectorsIn(translation);
      const missing = required.filter((category) => !declared.has(category));
      if (missing.length > 0) pluralGaps.push({ id, missing });
    }
  }

  return { locale, total, translated: total - untranslated.length, untranslated, pluralGaps };
}

const percent = ({ total, translated }) => (total === 0 ? 100 : Math.floor((translated / total) * 100));

export function formatCoverageTable(rows) {
  const width = Math.max(...rows.map((row) => row.locale.length));
  return rows
    .map((row) => {
      const marker = row.gated ? 'picker' : '';
      const coverage = row.missingCatalog ? 'no catalog' : `${percent(row)}%`;
      return `  ${row.locale.padEnd(width)}  ${String(row.translated).padStart(5)}/${row.total}  ${coverage.padStart(10)}  ${marker}`;
    })
    .join('\n');
}

export function formatShortfalls(rows) {
  const lines = [];
  for (const row of rows) {
    if (row.missingCatalog) {
      lines.push(`  ${row.locale}: no catalog at ${CATALOG_REL(row.locale)}`);
      continue;
    }
    lines.push(`  ${row.locale}: ${percent(row)}% translated`);
    if (row.untranslated.length > 0) {
      lines.push(`    ${row.untranslated.length} untranslated, starting with:`);
      for (const id of row.untranslated.slice(0, 5)) lines.push(`      ${JSON.stringify(id)}`);
    }
    for (const gap of row.pluralGaps.slice(0, 5)) {
      lines.push(`    ${JSON.stringify(gap.id)} is missing plural categories: ${gap.missing.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function main() {
  const localesSource = readFileSync(join(OK_ROOT, LOCALES_TS), 'utf8');
  const locales = readSupportedLocales(localesSource);
  const picker = new Set(readPickerLocales(localesSource));

  const sourcePath = join(OK_ROOT, CATALOG_REL(SOURCE_LOCALE));
  const sourceMessages = parsePoCatalog(readFileSync(sourcePath, 'utf8'));

  const rows = locales.map((locale) => {
    const path = join(OK_ROOT, CATALOG_REL(locale));
    const catalog = existsSync(path) ? parsePoCatalog(readFileSync(path, 'utf8')) : undefined;
    return {
      ...measureCoverage({
        locale,
        sourceMessages,
        catalog,
        isSource: locale === SOURCE_LOCALE,
      }),
      gated: picker.has(locale),
    };
  });

  console.log(`i18n catalog coverage (${sourceMessages.size} messages):`);
  console.log(formatCoverageTable(rows));

  const shortfalls = rows.filter(
    (row) => row.gated && (row.missingCatalog || row.untranslated.length > 0 || row.pluralGaps.length > 0),
  );
  if (shortfalls.length === 0) {
    console.log(`\nAll ${picker.size} picker locale(s) complete.`);
    return 0;
  }

  console.error('\nERROR: a locale offered in the Settings picker is incomplete.');
  console.error('');
  console.error(formatShortfalls(shortfalls));
  console.error('');
  console.error('  Either finish the catalog, or take the locale out of PICKER_LOCALES');
  console.error(`  in ${LOCALES_TS} until someone who reads it has reviewed it.`);
  console.error('  Review and promotion process: packages/app/src/locales/REVIEW.md');
  console.error('  Locked terminology: packages/app/src/locales/GLOSSARY.md');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
