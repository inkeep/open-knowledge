/**
 * Lingui i18n bootstrap. Imported once (from `main.tsx`) before the React tree
 * mounts so the active catalog is in place for the first render.
 *
 * Only the `en` source catalog is loaded today. Real locales — and a runtime
 * locale switcher (`i18n.load(locale, …)` + `i18n.activate(locale)`) — are
 * follow-up work; the `pseudo` catalog exists for coverage verification and is
 * loaded on demand, not in the production path.
 *
 * The compiled catalog (`../locales/en/messages.json`) is generated + committed by
 * `bun run i18n`, which extracts, compiles, and formats the catalogs.
 */
import type { Messages } from '@lingui/core';
import { i18n } from '@lingui/core';
import catalog from '@/locales/en/messages.json';

const DEFAULT_LOCALE = 'en';

i18n.load(DEFAULT_LOCALE, catalog.messages as unknown as Messages);
i18n.activate(DEFAULT_LOCALE);

export { i18n };
