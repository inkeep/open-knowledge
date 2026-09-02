#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCleanEnv } from './git-clean-env.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const SOURCE_LOCALE = 'en';
const LOCALES_TS = 'packages/core/src/i18n/locales.ts';
const CATALOG_REL = (locale) => `packages/app/src/locales/${locale}/messages.po`;

export function readSupportedLocales(source) {
  const block = /export const SUPPORTED_LOCALES\s*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!block) {
    throw new Error(`Could not find a SUPPORTED_LOCALES array in ${LOCALES_TS}`);
  }
  const tags = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (tags.length === 0) {
    throw new Error(`SUPPORTED_LOCALES in ${LOCALES_TS} parsed as empty`);
  }
  return tags;
}

function unquotePoString(literal) {
  return literal
    .slice(1, -1)
    .replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch));
}

export function parsePoCatalog(text) {
  const entries = new Map();
  let field = null;
  let msgid = null;
  let msgstr = null;
  let msgctxt = null;

  const flush = () => {
    if (msgid) {
      entries.set(msgctxt ? `${msgctxt}${msgid}` : msgid, msgstr ?? '');
    }
    field = null;
    msgid = null;
    msgstr = null;
    msgctxt = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('#')) continue;

    const ctxtLine = /^msgctxt\s+(".*")$/.exec(line);
    const idLine = /^msgid\s+(".*")$/.exec(line);
    const strLine = /^msgstr\s+(".*")$/.exec(line);
    const continuation = /^(".*")$/.exec(line);
    if (ctxtLine) {
      msgctxt = unquotePoString(ctxtLine[1]);
      field = 'msgctxt';
    } else if (idLine) {
      msgid = unquotePoString(idLine[1]);
      field = 'msgid';
    } else if (strLine) {
      msgstr = unquotePoString(strLine[1]);
      field = 'msgstr';
    } else if (continuation) {
      const chunk = unquotePoString(continuation[1]);
      if (field === 'msgctxt') msgctxt += chunk;
      else if (field === 'msgid') msgid += chunk;
      else if (field === 'msgstr') msgstr = (msgstr ?? '') + chunk;
    } else {
      field = null;
    }
  }
  flush();
  return entries;
}

export function pluralSelectorsIn(icu) {
  const found = new Set();
  for (const match of icu.matchAll(/,\s*plural\s*,/g)) {
    let depth = 0;
    let token = '';
    for (let i = match.index + match[0].length; i < icu.length; i++) {
      const ch = icu[i];
      if (ch === '{') {
        if (depth === 0) {
          const selector = token.trim().split(/\s+/).pop();
          if (selector) found.add(selector);
          token = '';
        }
        depth++;
      } else if (ch === '}') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0) {
        token += ch;
      }
    }
  }
  return found;
}

export function requiredPluralCategories(locale) {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}

export function findTranslationGaps({ baseMessages, headMessages, catalogs, targetLocales }) {
  const gaps = [];
  const missingCatalogs = targetLocales.filter((locale) => !catalogs.has(locale));

  const newMessages = [...headMessages.keys()].filter((id) => !baseMessages.has(id));

  for (const id of newMessages) {
    const sourceText = headMessages.get(id) || id;
    const needsPlural = pluralSelectorsIn(sourceText).size > 0;
    const empty = [];
    const incompletePlurals = [];

    for (const locale of targetLocales) {
      const catalog = catalogs.get(locale);
      if (!catalog) continue;
      const translation = catalog.get(id);
      if (!translation || translation.trim() === '') {
        empty.push(locale);
        continue;
      }
      if (needsPlural) {
        const declared = pluralSelectorsIn(translation);
        const missing = requiredPluralCategories(locale).filter((c) => !declared.has(c));
        if (missing.length > 0) incompletePlurals.push({ locale, missing });
      }
    }

    if (empty.length > 0 || incompletePlurals.length > 0) {
      gaps.push({ id, empty, incompletePlurals });
    }
  }

  return { newMessageCount: newMessages.length, gaps, missingCatalogs };
}

export function formatReport({ gaps, missingCatalogs }) {
  const lines = [];
  for (const locale of missingCatalogs) {
    lines.push(`  no catalog at ${CATALOG_REL(locale)}`);
  }
  for (const gap of gaps) {
    lines.push(`  ${JSON.stringify(gap.id)}`);
    if (gap.empty.length > 0) {
      lines.push(`    no translation: ${gap.empty.join(', ')}`);
    }
    for (const { locale, missing } of gap.incompletePlurals) {
      lines.push(`    ${locale} is missing plural categories: ${missing.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function git(args, { cwd = OK_ROOT } = {}) {
  const result = spawnSync('git', args, { cwd, env: gitCleanEnv(), encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function resolveBaseRef(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).ok) return candidate;
  }
  return null;
}

function main(argv) {
  const flagIndex = argv.indexOf('--base');
  const explicitBase = flagIndex === -1 ? null : argv[flagIndex + 1];

  const baseRef = resolveBaseRef([
    explicitBase,
    process.env.OK_I18N_BASE_REF,
    'origin/main',
    'main',
  ]);
  if (!baseRef) {
    console.error('ERROR: could not resolve a base ref to compare against.');
    console.error('');
    console.error('  Tried --base, OK_I18N_BASE_REF, origin/main, main.');
    console.error('  On a shallow clone, fetch the base branch first:');
    console.error('    git fetch --no-tags --depth=1 origin main');
    console.error('    node scripts/check-i18n-new-string-translations.mjs --base FETCH_HEAD');
    return 1;
  }

  const mergeBase = git(['merge-base', baseRef, 'HEAD']);
  const baseCommit = mergeBase.ok ? mergeBase.stdout : baseRef;

  const prefix = git(['rev-parse', '--show-prefix']).stdout;
  const basePo = git(['show', `${baseCommit}:${prefix}${CATALOG_REL(SOURCE_LOCALE)}`]);
  if (!basePo.ok) {
    console.error(`ERROR: could not read ${CATALOG_REL(SOURCE_LOCALE)} at ${baseRef}.`);
    console.error(`  ${basePo.stderr}`);
    return 1;
  }

  const locales = readSupportedLocales(readFileSync(join(OK_ROOT, LOCALES_TS), 'utf8'));
  const targetLocales = locales.filter((locale) => locale !== SOURCE_LOCALE);

  const catalogs = new Map();
  for (const locale of targetLocales) {
    const path = join(OK_ROOT, CATALOG_REL(locale));
    if (!existsSync(path)) continue;
    catalogs.set(locale, parsePoCatalog(readFileSync(path, 'utf8')));
  }

  const result = findTranslationGaps({
    baseMessages: parsePoCatalog(basePo.stdout),
    headMessages: parsePoCatalog(readFileSync(join(OK_ROOT, CATALOG_REL(SOURCE_LOCALE)), 'utf8')),
    catalogs,
    targetLocales,
  });

  if (result.gaps.length === 0 && result.missingCatalogs.length === 0) {
    console.log(
      `i18n: ${result.newMessageCount} new message(s) since ${baseRef}, translated in all ${targetLocales.length} locales.`,
    );
    return 0;
  }

  console.error('ERROR: new user-facing messages are missing translations.');
  console.error('');
  console.error(formatReport(result));
  console.error('');
  console.error('  A message added in a change lands translated in that same change.');
  console.error('  Fill the msgstr in each locale listed, then re-run:');
  console.error('    cd packages/app && pnpm run i18n');
  console.error('  Locked terminology: packages/app/src/locales/GLOSSARY.md');
  console.error('  How-to: plugins/ok/skills/translate-ui-strings/SKILL.md');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
