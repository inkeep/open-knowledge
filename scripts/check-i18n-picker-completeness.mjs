#!/usr/bin/env node
/**
 * Report per-locale catalog coverage, and fail when a locale the Settings picker
 * offers is not complete.
 *
 * Sibling to `check-i18n-new-string-translations.mjs` and deliberately the other
 * shape: that one is a delta, so the untranslated backlog on the eight
 * unpromoted catalogs stays out of it; this one is absolute, because a locale a
 * user can actually select must be complete — a picker entry backed by a partial
 * catalog means someone chooses a language and gets half of it in English, which
 * is worse than not offering it at all.
 *
 * The gated set is `PICKER_LOCALES`, read from core rather than restated, so
 * promoting a locale is still the one-line change in core it is meant to be.
 * Coverage is reported for every enumerated locale so the unpromoted ones stay
 * visible instead of silently rotting.
 *
 * `en` is complete by construction: its msgstr IS the English text, so measuring
 * it against itself would only ever confirm the tautology.
 *
 * Usage:
 *   node scripts/check-i18n-picker-completeness.mjs
 */

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

/** The reviewed subset the Settings picker offers, from core's own tuple. */
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

/**
 * One locale's coverage against the source catalog.
 *
 * Keyed off the SOURCE catalog's message set rather than the target's, so a
 * locale whose catalog is stale — missing entries entirely rather than holding
 * empty ones — counts those as untranslated instead of scoring 100% on a
 * smaller denominator.
 */
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
