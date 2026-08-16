import { defineConfig } from '@lingui/cli';
import { formatter } from '@lingui/format-po';

/**
 * Lingui i18n configuration for the OpenKnowledge editor frontend.
 *
 * `pseudo` is a generated pseudolocalization locale — `lingui extract` derives
 * it from `en` with no translation step. Loading a development build with
 * `?lang=pseudo` activates it (`src/lib/dev-pseudo-locale.ts`), which visually
 * marks every wrapped string so unwrapped (still-hardcoded) copy is obvious
 * during the rolling string-migration. It is not a supported language: it never
 * reaches the config enum or the picker, and a shipped build neither answers to
 * the parameter nor carries the catalog.
 *
 * Compiled catalogs (`messages.json`) are committed alongside the `.po` sources
 * so the same import path resolves under Vite dev, the production build, the
 * Electron renderer, and the test runtime without a per-entrypoint compile
 * step. `i18n:compile` is also wired into `predev` / `build` to keep them
 * fresh and Biome-formatted; run `pnpm run i18n` after adding strings.
 *
 * `locales` is `SUPPORTED_LOCALES` from `@inkeep/open-knowledge-core` plus the
 * generated `pseudo`. It is spelled out literally rather than imported: the
 * Lingui CLI loads this file through its own TS loader, before any workspace
 * build, so a cross-package import would make catalog extraction depend on
 * core's build output. `tests/meta/supported-locales-sync.test.ts` pins the two
 * lists equal instead — a config value with no catalog behind it is a user
 * choosing a language and getting English.
 */
export default defineConfig({
  sourceLocale: 'en',
  locales: [
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
    'pseudo',
  ],
  pseudoLocale: 'pseudo',
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['src'],
      exclude: ['**/node_modules/**', '**/*.test.*', '**/*.e2e.*', '**/*.stories.*'],
    },
  ],
  // `lineNumbers: false` keeps the `.po` catalogs free of source-line
  // references, so moving a string within a file produces no catalog diff.
  format: formatter({ lineNumbers: false }),
});
