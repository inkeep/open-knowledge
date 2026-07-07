import { defineConfig } from '@lingui/cli';
import { formatter } from '@lingui/format-po';

/**
 * Lingui i18n configuration for the OpenKnowledge editor frontend.
 *
 * `pseudo` is a generated pseudolocalization locale — `lingui extract` derives
 * it from `en` with no translation step. Activating it at runtime visually
 * marks every wrapped string, so unwrapped (still-hardcoded) copy is obvious
 * during the rolling string-migration.
 *
 * Compiled catalogs (`messages.json`) are committed alongside the `.po` sources
 * so the same import path resolves under Vite dev, the production build, the
 * Electron renderer, and the Bun test runtime without a per-entrypoint compile
 * step. `i18n:compile` is also wired into `predev` / `build` to keep them
 * fresh and Biome-formatted; run `bun run i18n` after adding strings.
 */
export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'pseudo'],
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
