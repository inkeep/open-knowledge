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
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly mainDir: string;
}

export function resolveMenuCatalogDir(deps: MenuCatalogDirDeps): string {
  if (deps.isPackaged) return join(deps.resourcesPath, 'locales');
  return join(deps.mainDir, '..', '..', '..', 'app', 'src', 'locales');
}

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

export function createMenuTranslator(catalogDir: string, locale: string): MenuTranslator {
  const messages = loadCompiledCatalog(catalogDir, locale) ?? {};
  const i18n = setupI18n({ locale, messages: { [locale]: messages } });
  return (message, values) => i18n._(generateMessageId(message), values ?? {}, { message });
}
