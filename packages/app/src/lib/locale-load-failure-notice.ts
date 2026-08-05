/**
 * What the user sees when the catalog for the language they asked for does not
 * arrive.
 *
 * The interface stays on the language it is already showing. Dropping back to
 * English mid-session reads as data loss to someone who was reading Chinese: a
 * whole screen of text changes at once, and nothing on it says why. So this is
 * a notice about a switch that did not happen, not a report of a language that
 * went away.
 *
 * The copy has to come out of the catalog that is still loaded, which is the
 * one already on screen — the requested catalog is precisely the thing that did
 * not arrive. Both the `t` macro and `i18n.locale` below resolve when the
 * notice fires rather than at module load, so that falls out of calling them
 * here instead of hoisting either to a constant.
 */

import type { SupportedLocale } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { i18n } from './i18n';

/**
 * Shared id, so a language that fails twice replaces its own notice instead of
 * stacking a second identical one behind the first.
 */
const NOTICE_ID = 'ok-locale-load-failed';

export interface LocaleLoadFailureNotice {
  /** The language whose catalog did not load. */
  locale: SupportedLocale;
  /**
   * How the offered retry is carried out. Defaults to reloading, and tests
   * pass their own — a real reload would take the test's page with it.
   */
  reload?: () => void;
}

/**
 * Reloading is not a heavy-handed stand-in for fetching the catalog again: it
 * is the only thing that can work.
 *
 * A document remembers a module it failed to fetch and keeps rejecting every
 * later import of the same URL, without going back to the network — the module
 * map records the failure rather than the absence (HTML, "fetch a single module
 * script"). Verified in Chromium: after the fetch is unblocked, a plain `fetch`
 * of the catalog returns 200 while `import()` of it still rejects instantly.
 * So an in-place retry would fail for as long as the tab is open, however good
 * the connection had become, and would look like a button that does nothing.
 * A fresh document is what clears that memory.
 *
 * Picking a DIFFERENT language after a failure does work in place, because that
 * is a different URL and carries no such memory.
 */
function reloadDocument(): void {
  window.location.reload();
}

export function showLocaleLoadFailureNotice({
  locale,
  reload = reloadDocument,
}: LocaleLoadFailureNotice): void {
  // Named in the active locale, not the requested one: a user who reads Spanish
  // and asked for Chinese should be told about "chino simplificado", not about
  // "简体中文".
  const language = new Intl.DisplayNames([i18n.locale], { type: 'language' }).of(locale) ?? locale;

  toast.error(t`Couldn't switch to ${language}.`, {
    id: NOTICE_ID,
    description: t`The interface is still in the language you were reading. Check your connection, then reload to try again.`,
    // The switch was a deliberate act, so its failure should not scroll past
    // while the user is looking elsewhere. The toaster's close button and the
    // action below are both ways out.
    duration: Number.POSITIVE_INFINITY,
    action: { label: t`Reload`, onClick: reload },
  });
}

/**
 * Take the notice back once a language does load.
 *
 * Without this, picking a second language that works leaves the complaint about
 * the first one sitting over an interface that already switched.
 */
export function dismissLocaleLoadFailureNotice(): void {
  toast.dismiss(NOTICE_ID);
}
