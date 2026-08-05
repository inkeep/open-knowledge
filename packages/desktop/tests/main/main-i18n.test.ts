import { join } from 'node:path';
import { MENU_LABELS, NATIVE_MENU_LABELS } from '@inkeep/open-knowledge-core';
import { generateMessageId } from '@lingui/message-utils/generateMessageId';
import { describe, expect, test } from 'vitest';
import {
  createMenuTranslator,
  loadCompiledCatalog,
  resolveMenuCatalogDir,
} from '../../src/main/main-i18n.ts';
import { translateEnglish } from '../../src/main/menu-translator.ts';

/**
 * These run against the REAL committed catalogs in `packages/app/src/locales`,
 * not fixtures. The whole point of the design is that main reads the same
 * compiled files the renderer does, keyed by a hash of the English source — a
 * fixture catalog would prove the hashing works against itself and nothing
 * about whether the two sides actually agree.
 */
const REAL_CATALOG_DIR = join(import.meta.dirname, '..', '..', '..', 'app', 'src', 'locales');

describe('loadCompiledCatalog', () => {
  test('reads a real compiled catalog', () => {
    const messages = loadCompiledCatalog(REAL_CATALOG_DIR, 'es');
    expect(messages).not.toBeNull();
    expect(Object.keys(messages ?? {}).length).toBeGreaterThan(2000);
  });

  test('returns null for a locale with no catalog rather than throwing', () => {
    expect(loadCompiledCatalog(REAL_CATALOG_DIR, 'kl')).toBeNull();
  });

  test('returns null for a directory that does not exist', () => {
    expect(loadCompiledCatalog(join(REAL_CATALOG_DIR, 'nope'), 'es')).toBeNull();
  });
});

describe('createMenuTranslator', () => {
  test('translates a menu label through the shared catalog', () => {
    const translate = createMenuTranslator(REAL_CATALOG_DIR, 'es');
    // Spanish and English share no menu vocabulary here, so a passthrough
    // implementation cannot produce this.
    expect(translate('Reveal in Finder')).toBe('Mostrar en el Finder');
    expect(translate('Copy path')).toBe('Copiar ruta');
  });

  test('translates the Electron role labels the menu now supplies explicitly', () => {
    const translate = createMenuTranslator(REAL_CATALOG_DIR, 'zh-Hans');
    expect(translate('Select All')).toBe('全选');
    expect(translate('Toggle Full Screen')).toBe('切换全屏');
  });

  test('fills placeholders from the translated form, not the English one', () => {
    const translate = createMenuTranslator(REAL_CATALOG_DIR, 'es');
    const rendered = translate('Quit {appName}', { appName: 'OpenKnowledge' });
    expect(rendered).toContain('OpenKnowledge');
    expect(rendered).not.toBe('Quit OpenKnowledge');
  });

  test('renders the English source for a message the catalog does not carry', () => {
    const translate = createMenuTranslator(REAL_CATALOG_DIR, 'es');
    expect(translate('Zzz not a real menu label')).toBe('Zzz not a real menu label');
  });

  test('renders English throughout when the catalog cannot be read', () => {
    const translate = createMenuTranslator(join(REAL_CATALOG_DIR, 'nope'), 'es');
    expect(translate('Reveal in Finder')).toBe('Reveal in Finder');
    expect(translate('Quit {appName}', { appName: 'OpenKnowledge' })).toBe('Quit OpenKnowledge');
  });

  test('en resolves to the same strings the English fallback produces', () => {
    const translate = createMenuTranslator(REAL_CATALOG_DIR, 'en');
    for (const source of ['Reveal in Finder', 'Select All', 'Actual Size', 'Recent project']) {
      expect(translate(source)).toBe(translateEnglish(source));
    }
    expect(translate('Hide {appName}', { appName: 'OpenKnowledge' })).toBe('Hide OpenKnowledge');
  });
});

describe('every menu string main can render resolves to a real catalog key', () => {
  // The renderer-side parity suite checks these by string VALUE, because that
  // package aliases the Lingui macros to an English passthrough and its
  // descriptors carry no real id. This is the other half: the exact hash main
  // computes, against the real catalog. A source string missing here renders
  // English in every language, and nothing else would notice.
  const catalog = loadCompiledCatalog(REAL_CATALOG_DIR, 'en') ?? {};
  const sources = [...Object.values(NATIVE_MENU_LABELS), ...Object.values(MENU_LABELS)];

  test('the catalog was read', () => {
    expect(Object.keys(catalog).length).toBeGreaterThan(2000);
  });

  test('no source string hashes to a key the catalog lacks', () => {
    const missing = sources.filter((source) => !(generateMessageId(source) in catalog));
    expect(missing).toEqual([]);
  });
});

describe('resolveMenuCatalogDir', () => {
  test('packaged builds read the extraResources copy', () => {
    expect(
      resolveMenuCatalogDir({
        isPackaged: true,
        resourcesPath: '/Apps/OpenKnowledge.app/Contents/Resources',
        mainDir: '/Apps/OpenKnowledge.app/Contents/Resources/app.asar/out/main',
      }),
    ).toBe('/Apps/OpenKnowledge.app/Contents/Resources/locales');
  });

  test('dev builds read the app package catalogs the i18n script rewrites', () => {
    expect(
      resolveMenuCatalogDir({
        isPackaged: false,
        resourcesPath: '/unused',
        mainDir: '/repo/packages/desktop/out/main',
      }),
    ).toBe('/repo/packages/app/src/locales');
  });

  test('the dev path names a directory that really holds the catalogs', () => {
    const devDir = resolveMenuCatalogDir({
      isPackaged: false,
      resourcesPath: '/unused',
      mainDir: join(import.meta.dirname, '..', '..', 'out', 'main'),
    });
    expect(loadCompiledCatalog(devDir, 'en')).not.toBeNull();
  });
});

describe('translateEnglish', () => {
  test('returns the source untouched when no values are supplied', () => {
    expect(translateEnglish('Select All')).toBe('Select All');
    expect(translateEnglish('Quit {appName}')).toBe('Quit {appName}');
  });

  test('substitutes named placeholders and leaves unknown ones alone', () => {
    expect(translateEnglish('Quit {appName}', { appName: 'OpenKnowledge' })).toBe(
      'Quit OpenKnowledge',
    );
    expect(translateEnglish('Look Up "{word}"', { other: 'x' })).toBe('Look Up "{word}"');
  });

  test('does not rescan a substituted value for further placeholders', () => {
    expect(translateEnglish('Look Up "{word}"', { word: '{appName}', appName: 'boom' })).toBe(
      'Look Up "{appName}"',
    );
  });
});
