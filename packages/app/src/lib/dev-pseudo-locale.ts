import type { Messages } from '@lingui/core';
import { i18n } from './i18n';

const PSEUDO_LOCALE = 'pseudo';

export function isPseudoLocaleRequested(): boolean {
  if (import.meta.env.PROD === true) return false;
  return new URLSearchParams(window.location.search).get('lang') === PSEUDO_LOCALE;
}

export async function activatePseudoLocale(): Promise<void> {
  if (import.meta.env.PROD === true) return;

  const { default: catalog } = await import('@/locales/pseudo/messages.json');
  i18n.load(PSEUDO_LOCALE, catalog.messages as unknown as Messages);
  i18n.activate(PSEUDO_LOCALE);
}
