/**
 * Registers `okSyntaxTheme` with Pierre and hands back the name to pass as a
 * `theme` option.
 *
 * Every Pierre surface must call this. Left unset, Pierre falls back to
 * `DEFAULT_THEMES` (`pierre-light`/`pierre-dark`), a bundled brand palette no
 * app theme can reach — so the diff chrome would track the user's color theme
 * while the code inside it stayed Pierre-branded.
 *
 * Registration is a one-shot side effect on a module-global Pierre registry,
 * not per-instance state, hence the latch: Pierre logs an error and drops the
 * second call for a name it already holds.
 */

import { registerCustomTheme } from '@pierre/diffs';
import { OK_SYNTAX_THEME_NAME, okSyntaxTheme } from './ok-syntax-theme';

let registered = false;

/** Idempotent. Safe to call during render or from an effect. */
export function okPierreTheme(): string {
  if (!registered) {
    registerCustomTheme(OK_SYNTAX_THEME_NAME, () => Promise.resolve(okSyntaxTheme));
    registered = true;
  }
  return OK_SYNTAX_THEME_NAME;
}
