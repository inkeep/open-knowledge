import {
  AUTO_DETECTABLE_LOCALES,
  type LanguagePreference,
  localeDirection,
  readBrowserLanguages,
  resolveLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@inkeep/open-knowledge-core';
import { useEffect } from 'react';
import { dynamicActivate } from './activate-locale';
import { activatePseudoLocale, isPseudoLocaleRequested } from './dev-pseudo-locale';
import {
  dismissLocaleLoadFailureNotice,
  showLocaleLoadFailureNotice,
} from './locale-load-failure-notice';

/**
 * localStorage key the pre-paint script in `index.html` reads before any bundle
 * loads, so the first painted frame is already in the user's language and
 * direction instead of flipping to it once config arrives.
 *
 * That script cannot import anything, so it spells the field names below
 * (`pref`, `locale`, `dir`) as string literals with no compile-time link to
 * this writer. `language-fouc-prepaint.dom.test.ts` runs the real script over
 * this function's real output, which is what couples the two.
 */
export const LANGUAGE_CACHE_STORAGE_KEY = 'ok-language-v1';

export interface ApplyLanguageInput {
  /** The saved choice, unresolved — `'system'` arrives as `'system'`. */
  preference: LanguagePreference;
  /** What that choice resolves to right now. */
  locale: SupportedLocale;
}

/**
 * Put the active language on `<html>` and mirror it into the cache the
 * pre-paint script reads on the next load. Idempotent.
 *
 * `lang` is what tells the engine which shaper and font stack to use, and `dir`
 * is the chrome's base direction. Both are derived from the locale rather than
 * stored separately, so the layout cannot end up disagreeing with the language.
 *
 * The cache carries the **unresolved** preference beside the resolved locale,
 * and that pairing is the point rather than redundancy. The sibling theme cache
 * is genuinely next-themes' preference store — it is read back as the user's
 * choice — so anyone extending this one by that precedent will reach for it the
 * same way. Keeping `pref` here means what they find is the sentinel the user
 * actually chose; a lone resolved tag would read as a deliberate pick and stop
 * following the OS from then on.
 *
 * The script paints the cached locale as-is and never re-resolves: matching an
 * OS language list to a catalog needs the maximizing matcher, which is bundle
 * code and would become a second copy of the negotiation rules. The residual is
 * one frame in the previous language for a `'system'` user whose OS language
 * changed while the app was closed — the effect below corrects it as soon as
 * config lands.
 */
export function applyLanguageToDom({ preference, locale }: ApplyLanguageInput): void {
  if (typeof document === 'undefined') return;

  const dir = localeDirection(locale);
  const root = document.documentElement;
  root.lang = locale;
  root.dir = dir;

  try {
    localStorage.setItem(
      LANGUAGE_CACHE_STORAGE_KEY,
      JSON.stringify({ pref: preference, locale, dir }),
    );
  } catch {
    // Private mode or storage disabled. The attributes above are already
    // applied, so this session is correct; only the next load's head start is
    // forgone, which is a slower first frame rather than a wrong one.
  }
}

/**
 * The saved choice as the cache last recorded it, or `undefined` when there is
 * nothing usable there.
 *
 * For window kinds that never mount a `ConfigProvider` — the launcher opens
 * before any project is chosen, so there is no CRDT to read a preference from.
 * Without this they render the bootstrap catalog forever, which shows up as a
 * translated menu bar above an English launcher: the menus come from the main
 * process, which resolves the preference off disk at boot and does not depend
 * on a window at all.
 *
 * The cache is the same one the pre-paint script reads, so the launcher agrees
 * with the `lang` and `dir` already on `<html>` rather than introducing a second
 * source. Reading `pref` rather than `locale` is what keeps `'system'` tracking
 * the OS: the resolver re-runs against the current browser list, so a launcher
 * opened after the OS language changed follows it.
 */
export function narrowLanguagePreference(value: unknown): LanguagePreference | undefined {
  if (value === 'system') return 'system';
  return SUPPORTED_LOCALES.includes(value as SupportedLocale)
    ? (value as SupportedLocale)
    : undefined;
}

export function readCachedLanguagePreference(): LanguagePreference | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY);
    if (raw === null) return undefined;
    return narrowLanguagePreference((JSON.parse(raw) as { pref?: unknown }).pref);
  } catch {
    // Absent, unreadable, or written by a newer shape. Falling through to
    // `undefined` means the caller resolves from the browser list, which is
    // the same thing a first-ever launch does.
    return undefined;
  }
}

/**
 * Apply the merged-config `appearance.language` to the Lingui singleton,
 * app-wide. Owned by `ConfigProvider`; the single seam that turns a config
 * value (the Settings pane, an external file edit picked up by the chokidar
 * watcher, or another window) into the language the interface speaks.
 *
 * Applied imperatively rather than passed down as a prop because `I18nProvider`
 * (in `main.tsx`) is mounted above `ConfigProvider` (in `App.tsx`) — the config
 * that holds the preference does not exist yet when the provider is
 * constructed. `I18nProvider`
 * re-renders the tree off Lingui's own change subscription, so activating here
 * is enough; the switch happens in place with no reload.
 *
 * `'system'` is resolved HERE, at activation, and never on the way to storage.
 * A preference stored as a concrete tag would freeze at whatever the OS
 * reported the day it was picked and silently stop following it — the same
 * one-way contract `appearance.theme` keeps for its own `'system'` value.
 *
 * `userConfigSynced` distinguishes "the user layer has not loaded yet" from
 * "the user has no preference", which look identical on the value alone. Both
 * are `undefined`, but they call for opposite behaviour: while the layer is
 * still loading the bootstrap catalog has to stand, and once it has loaded an
 * absent preference means follow the browser. Acting on the un-loaded state
 * would activate the browser's language on every boot and then correct it,
 * costing a second catalog fetch and a visible flash for anyone who has chosen
 * a language other than their OS one.
 *
 * No storm guard is needed, unlike the theme bridge. This hook does write
 * shared storage — all OK windows see one `localStorage` — but nothing
 * subscribes to `storage` events for the language cache, so a write cannot
 * re-enter this effect in another window and be echoed back. Adding such a
 * listener is what would reopen the multi-window flicker storm that guard
 * exists to prevent.
 */
export function useApplyConfigLanguage({
  preference,
  userConfigSynced,
}: {
  preference: LanguagePreference | undefined;
  userConfigSynced: boolean;
}): void {
  useEffect(() => {
    // Ahead of the sync check on purpose: a reviewer sweeping for unwrapped
    // strings wants the marking from the first frame, and is overriding the
    // preference anyway. Constant `false` in a production build, so this
    // branch is unreachable there and the configured language still applies.
    if (isPseudoLocaleRequested()) {
      void activatePseudoLocale().catch((error: unknown) => {
        console.warn(
          JSON.stringify({ event: 'ok-pseudo-locale-activate-failed', error: String(error) }),
        );
      });
      // No paint and no cache write: the pseudolocale is an instrument rather
      // than a language, so it lasts exactly as long as the query parameter
      // asking for it.
      return;
    }

    if (!userConfigSynced) return;

    const { locale } = resolveLocale({
      // No override tier in the renderer — `OK_LANG` and `--lang` are process
      // arguments, and the browser has neither.
      override: undefined,
      storedPreference: preference,
      preferenceList: readBrowserLanguages(),
      // The whole enumerated set, not the picker subset: a preference naming an
      // unpromoted locale has to resolve, or a translator cannot run the app in
      // the language they are translating.
      supportedLocales: SUPPORTED_LOCALES,
      // The browser's list is a guess, though, and the locales whose chrome
      // layout is unfinished are not something to guess someone into — they
      // stay reachable by asking for them by name.
      autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
    });

    // Superseded by a later preference change while the catalog was in flight.
    // `dynamicActivate` already declines to activate a stale locale; without the
    // same guard here the losing call would still stamp its locale onto `<html>`
    // and into the cache, leaving the attributes describing a language the app
    // is not showing and seeding the next load with it.
    let superseded = false;

    // The catalog arrives over the network, so this can genuinely fail — a
    // dropped connection, or a path that resolves in dev and not in a packaged
    // build. `dynamicActivate` leaves the current locale active and records
    // nothing as loaded when it fails, so the interface stays readable in the
    // language it was already showing, and the notice takes it from there.
    dynamicActivate(locale)
      .then(() => {
        if (superseded) return;
        // Clears any notice left by an earlier language that failed. The user
        // is now reading something that worked; a complaint about the one that
        // did not would just be sitting over it.
        dismissLocaleLoadFailureNotice();
        // Only after the catalog is actually active, so a failed load leaves
        // `<html>` describing the language still on screen rather than the one
        // that never arrived.
        applyLanguageToDom({ preference: preference ?? 'system', locale });
      })
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({ event: 'ok-locale-activate-failed', locale, error: String(error) }),
        );
        // Nothing to say about a switch the user has already navigated away
        // from — the language they landed on is on screen and correct.
        if (superseded) return;
        showLocaleLoadFailureNotice({ locale });
      });

    return () => {
      superseded = true;
    };
  }, [preference, userConfigSynced]);
}
