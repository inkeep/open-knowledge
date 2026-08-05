/**
 * Lingui i18n bootstrap. Imported once (from `main.tsx`) before the React tree
 * mounts so the active catalog is in place for the first render.
 *
 * **The `en` import here must stay static.** `uninstall.html` mounts its own
 * `I18nProvider` off this module and loads everything eagerly — it renders after
 * `~/.ok` has been removed and the server stopped, so it cannot wait on a chunk
 * arriving over the wire. Every other locale is fetched from
 * `activate-locale.ts`, which the uninstall entry does not import. Lingui wants
 * a compiled catalog for the source locale anyway: default messages are stripped
 * from production builds, so `en` is a real catalog rather than an assumed
 * default.
 *
 * The bootstrap locale is the resolver's fallback by construction — whatever the
 * resolver falls back to has to be readable with no network — so both read the
 * same constant instead of agreeing by coincidence.
 *
 * The compiled catalog (`../locales/en/messages.json`) is generated + committed by
 * `pnpm run i18n`, which extracts, compiles, and formats the catalogs.
 */
import { FALLBACK_LOCALE } from '@inkeep/open-knowledge-core';
import type { Messages } from '@lingui/core';
import { i18n } from '@lingui/core';
import catalog from '@/locales/en/messages.json';

i18n.load(FALLBACK_LOCALE, catalog.messages as unknown as Messages);
i18n.activate(FALLBACK_LOCALE);

export { i18n };
