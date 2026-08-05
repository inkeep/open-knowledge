/**
 * Main-process translation for the native menus, backed by the SAME compiled
 * catalogs the renderer loads.
 *
 * There is no second copy of the translations and no second catalog format:
 * `@lingui/core` is framework-agnostic, so main mints its own `setupI18n()`
 * instance and loads `messages.json` straight off disk. The catalogs are keyed
 * by a hash of the English source rather than by the source text, so
 * `generateMessageId` is what bridges "the literal in `NATIVE_MENU_LABELS`" to
 * "the key in the catalog".
 *
 * Every lookup passes the English source as Lingui's `message` default, so a
 * key the catalog does not carry renders English rather than the raw hash —
 * the same graceful degradation a partially-translated locale needs anyway.
 *
 * Where the catalogs come from differs by build. In dev they are read out of
 * `packages/app/src/locales`; in a packaged app they ride `extraResources` to
 * `<Resources>/locales`. The renderer's own copy is bundled into its JS chunks,
 * so main cannot borrow it — hence the separate packaging rule.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Messages, setupI18n } from '@lingui/core';
import { generateMessageId } from '@lingui/message-utils/generateMessageId';
import { getLogger } from './desktop-logger.ts';
import type { MenuTranslator } from './menu-translator.ts';

interface CompiledCatalogFile {
  readonly messages?: Messages;
}

interface MenuCatalogDirDeps {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** `process.resourcesPath` — only read on the packaged branch. */
  readonly resourcesPath: string;
  /** `__dirname` of the running main bundle (`<desktop>/out/main`). */
  readonly mainDir: string;
}

/**
 * Absolute directory holding one `<locale>/messages.json` per catalog.
 *
 * The dev branch walks out of `out/main` to the app package's committed
 * catalogs, which is also what `pnpm run i18n` rewrites — so a dev build picks
 * up a recompiled catalog on the next menu rebuild with no copy step.
 */
export function resolveMenuCatalogDir(deps: MenuCatalogDirDeps): string {
  if (deps.isPackaged) return join(deps.resourcesPath, 'locales');
  return join(deps.mainDir, '..', '..', '..', 'app', 'src', 'locales');
}

/**
 * Read one compiled catalog. Returns null when the file is missing or
 * unreadable — a menu that renders English is a far better outcome than a boot
 * that throws, and the packaged-catalog path is exactly the kind of thing that
 * breaks silently in a build config rather than loudly in a test.
 *
 * Which is why it is logged rather than swallowed. Main has no DevTools, so an
 * English menu bar over a translated app is otherwise a symptom with no trail
 * — the log line names the directory the packaging rule was supposed to fill.
 */
export function loadCompiledCatalog(catalogDir: string, locale: string): Messages | null {
  try {
    const raw = readFileSync(join(catalogDir, locale, 'messages.json'), 'utf8');
    const parsed = JSON.parse(raw) as CompiledCatalogFile;
    return parsed.messages ?? null;
  } catch (err) {
    getLogger('main-i18n').warn(
      { err, locale, catalogDir },
      'compiled catalog unreadable; native menus fall back to English',
    );
    return null;
  }
}

/**
 * Build a translator for `locale` from `catalogDir`. Falls back to an empty
 * catalog — which renders every string as its English source — when the catalog
 * cannot be read.
 *
 * Passing the source as Lingui's `message` default is what makes a missing key
 * render English instead of the raw hash, so an unpromoted or partly-filled
 * catalog degrades one string at a time rather than all at once.
 */
export function createMenuTranslator(catalogDir: string, locale: string): MenuTranslator {
  const messages = loadCompiledCatalog(catalogDir, locale) ?? {};
  const i18n = setupI18n({ locale, messages: { [locale]: messages } });
  return (message, values) => i18n._(generateMessageId(message), values ?? {}, { message });
}
