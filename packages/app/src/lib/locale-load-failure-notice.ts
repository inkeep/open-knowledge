import type { SupportedLocale } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { i18n } from './i18n';

const NOTICE_ID = 'ok-locale-load-failed';

export interface LocaleLoadFailureNotice {
  locale: SupportedLocale;
  reload?: () => void;
}

function reloadDocument(): void {
  window.location.reload();
}

export function showLocaleLoadFailureNotice({
  locale,
  reload = reloadDocument,
}: LocaleLoadFailureNotice): void {
  const language = new Intl.DisplayNames([i18n.locale], { type: 'language' }).of(locale) ?? locale;

  toast.error(t`Couldn't switch to ${language}.`, {
    id: NOTICE_ID,
    description: t`The interface is still in the language you were reading. Check your connection, then reload to try again.`,
    duration: Number.POSITIVE_INFINITY,
    action: { label: t`Reload`, onClick: reload },
  });
}

export function dismissLocaleLoadFailureNotice(): void {
  toast.dismiss(NOTICE_ID);
}
