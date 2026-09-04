import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  findTranslationGaps,
  formatReport,
  parsePoCatalog,
  pluralSelectorsIn,
  readSupportedLocales,
  requiredPluralCategories,
  SOURCE_LOCALE,
} from './check-i18n-new-string-translations.mjs';
import { gitCleanEnv } from './git-clean-env.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCALES_TS = join(OK_ROOT, 'packages/core/src/i18n/locales.ts');

const catalogOf = (entries) => new Map(Object.entries(entries));

describe('locale enumeration', () => {
  const locales = readSupportedLocales(readFileSync(LOCALES_TS, 'utf8'));

  test('reads every enumerated locale out of core', () => {
    expect(locales).toEqual([
      'en',
      'zh-Hans',
      'zh-Hant',
      'hi',
      'es',
      'ar',
      'fr',
      'bn',
      'pt-BR',
      'id',
      'ur',
      'ko',
    ]);
  });

  test('every enumerated locale has a catalog on disk', () => {
    const missing = locales.filter(
      (locale) => !existsSync(join(OK_ROOT, `packages/app/src/locales/${locale}/messages.po`)),
    );
    expect(missing).toEqual([]);
  });

  test('refuses a source it cannot find the tuple in', () => {
    expect(() => readSupportedLocales("export const OTHER = ['en'];")).toThrow(/SUPPORTED_LOCALES/);
  });

  test('refuses an empty tuple rather than reporting zero locales to check', () => {
    expect(() => readSupportedLocales('export const SUPPORTED_LOCALES = [] as const;')).toThrow(
      /empty/,
    );
  });
});

describe('po parsing', () => {
  test('reads msgid and msgstr pairs and drops the header', () => {
    const catalog = parsePoCatalog(
      [
        'msgid ""',
        'msgstr ""',
        '"Language: es\\n"',
        '',
        '#: src/components/Thing.tsx',
        'msgid "Save"',
        'msgstr "Guardar"',
        '',
        'msgid "Discard"',
        'msgstr ""',
        '',
      ].join('\n'),
    );
    expect([...catalog.entries()]).toEqual([
      ['Save', 'Guardar'],
      ['Discard', ''],
    ]);
  });

  test('joins continuation lines into one message', () => {
    const catalog = parsePoCatalog(
      ['msgid ""', '"a long "', '"english sentence"', 'msgstr ""', '"una frase "', '"larga"'].join(
        '\n',
      ),
    );
    expect(catalog.get('a long english sentence')).toBe('una frase larga');
  });

  test('unescapes quotes and newlines', () => {
    const catalog = parsePoCatalog(
      ['msgid "Look up \\"it\\""', 'msgstr "Buscar \\"it\\"\\nya"'].join('\n'),
    );
    expect(catalog.get('Look up "it"')).toBe('Buscar "it"\nya');
  });

  test('does not let a trailing entry fall off when the file has no final blank line', () => {
    const catalog = parsePoCatalog('msgid "Last"\nmsgstr "Ultimo"');
    expect(catalog.get('Last')).toBe('Ultimo');
  });
});

describe('plural selectors', () => {
  test('finds the selectors of an ICU plural argument', () => {
    expect([...pluralSelectorsIn('{n, plural, one {# item} other {# items}}')].sort()).toEqual([
      'one',
      'other',
    ]);
  });

  test('is not confused by braces inside a selector body', () => {
    expect([...pluralSelectorsIn('{n, plural, one {a {b} c} other {d}} trailing')].sort()).toEqual([
      'one',
      'other',
    ]);
  });

  test('reads the selector, not an offset prefix', () => {
    expect([...pluralSelectorsIn('{n, plural, offset:1 one {#} other {#}}')]).toContain('one');
  });

  test('finds nothing in a message with no plural', () => {
    expect(pluralSelectorsIn('Just {count} words').size).toBe(0);
  });
});

describe('required plural categories', () => {
  test('Arabic needs all six', () => {
    expect(requiredPluralCategories('ar').sort()).toEqual([
      'few',
      'many',
      'one',
      'other',
      'two',
      'zero',
    ]);
  });

  test('Simplified Chinese needs only other', () => {
    expect(requiredPluralCategories('zh-Hans')).toEqual(['other']);
  });
});

describe('translation gaps', () => {
  const targetLocales = ['es', 'ar'];

  test('names the locales that left a newly added message empty', () => {
    const result = findTranslationGaps({
      baseMessages: catalogOf({}),
      headMessages: catalogOf({ Language: 'Language' }),
      catalogs: new Map([
        ['es', catalogOf({ Language: 'Idioma' })],
        ['ar', catalogOf({ Language: '' })],
      ]),
      targetLocales,
    });
    expect(result.newMessageCount).toBe(1);
    expect(result.gaps).toEqual([{ id: 'Language', empty: ['ar'], incompletePlurals: [] }]);
  });

  test('treats whitespace as empty', () => {
    const result = findTranslationGaps({
      baseMessages: catalogOf({}),
      headMessages: catalogOf({ Language: 'Language' }),
      catalogs: new Map([
        ['es', catalogOf({ Language: '   ' })],
        ['ar', catalogOf({ Language: 'اللغة' })],
      ]),
      targetLocales,
    });
    expect(result.gaps[0].empty).toEqual(['es']);
  });

  test('says nothing about a message that was already untranslated at the base', () => {
    const result = findTranslationGaps({
      baseMessages: catalogOf({ Save: 'Save' }),
      headMessages: catalogOf({ Save: 'Save' }),
      catalogs: new Map([
        ['es', catalogOf({ Save: '' })],
        ['ar', catalogOf({ Save: '' })],
      ]),
      targetLocales,
    });
    expect(result.newMessageCount).toBe(0);
    expect(result.gaps).toEqual([]);
  });

  test('a reworded message is a new message', () => {
    const result = findTranslationGaps({
      baseMessages: catalogOf({ 'Save it': 'Save it' }),
      headMessages: catalogOf({ 'Save this': 'Save this' }),
      catalogs: new Map([
        ['es', catalogOf({ 'Save it': 'Guardalo' })],
        ['ar', catalogOf({ 'Save it': 'احفظه' })],
      ]),
      targetLocales,
    });
    expect(result.gaps.map((g) => g.id)).toEqual(['Save this']);
    expect(result.gaps[0].empty).toEqual(['es', 'ar']);
  });

  test("a filled translation missing its locale's plural categories is a gap", () => {
    const id = '{n, plural, one {# file} other {# files}}';
    const result = findTranslationGaps({
      baseMessages: catalogOf({}),
      headMessages: catalogOf({ [id]: id }),
      catalogs: new Map([
        [
          'es',
          catalogOf({ [id]: '{n, plural, one {# archivo} many {# archivos} other {# archivos}}' }),
        ],
        ['ar', catalogOf({ [id]: '{n, plural, one {# ملف} other {# ملفات}}' })],
      ]),
      targetLocales,
    });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].incompletePlurals).toEqual([
      { locale: 'ar', missing: ['zero', 'two', 'few', 'many'] },
    ]);
  });

  test('reports a locale whose catalog is absent entirely', () => {
    const result = findTranslationGaps({
      baseMessages: catalogOf({}),
      headMessages: catalogOf({ Language: 'Language' }),
      catalogs: new Map([['es', catalogOf({ Language: 'Idioma' })]]),
      targetLocales,
    });
    expect(result.missingCatalogs).toEqual(['ar']);
  });
});

describe('report', () => {
  test('names the message and the locales that owe a translation', () => {
    const report = formatReport({
      gaps: [
        { id: 'Language', empty: ['ar', 'bn'], incompletePlurals: [] },
        {
          id: '{n, plural, ...}',
          empty: [],
          incompletePlurals: [{ locale: 'ar', missing: ['few'] }],
        },
      ],
      missingCatalogs: ['ur'],
    });
    expect(report).toContain('packages/app/src/locales/ur/messages.po');
    expect(report).toContain('"Language"');
    expect(report).toContain('no translation: ar, bn');
    expect(report).toContain('ar is missing plural categories: few');
  });
});

describe('wiring', () => {
  test('runs green over a base with nothing new', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-i18n-new-string-translations.mjs', '--base', 'HEAD'],
      { cwd: OK_ROOT, encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).toContain('0 new message(s)');
    expect(result.status).toBe(0);
  });

  test('is part of the drift-guard chain', () => {
    const pkg = JSON.parse(readFileSync(join(OK_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:drift:guards']).toContain(
      'node scripts/check-i18n-new-string-translations.mjs',
    );
  });

  test('the source locale is the one Lingui extracts from', () => {
    const linguiConfig = readFileSync(join(OK_ROOT, 'packages/app/lingui.config.ts'), 'utf8');
    expect(linguiConfig).toContain(`sourceLocale: '${SOURCE_LOCALE}'`);
  });
});

describe('invocation environment', () => {
  const SCRIPT = join(OK_ROOT, 'scripts/check-i18n-new-string-translations.mjs');

  const runCheck = ({ cwd = OK_ROOT, env = {} } = {}) =>
    spawnSync(process.execPath, [SCRIPT, '--base', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  const gitAt = (args, cwd = OK_ROOT) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: gitCleanEnv() }).stdout.trim();

  test('reads the base catalog when invoked from the repo root, not only from the subtree', () => {
    const result = runCheck({ cwd: gitAt(['rev-parse', '--show-toplevel']) });

    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).toContain('new message(s)');
    expect(result.status).toBe(0);
  });

  test('reads its own repository, not one a hook-exported GIT_DIR points at', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ok-i18n-decoy-'));
    try {
      const decoy = join(scratch, 'decoy');
      gitAt(['init', '--quiet', decoy]);
      gitAt(
        [
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=t',
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          'decoy',
        ],
        decoy,
      );

      const result = runCheck({ env: { GIT_DIR: join(decoy, '.git') } });

      expect(result.error).toBeUndefined();
      expect(result.stdout + result.stderr).toContain('new message(s)');
      expect(result.status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('survives the GIT_DIR a pre-push hook actually exports', () => {
    const result = runCheck({ env: { GIT_DIR: gitAt(['rev-parse', '--absolute-git-dir']) } });

    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).toContain('new message(s)');
    expect(result.status).toBe(0);
  });
});
