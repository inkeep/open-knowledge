/**
 * The notice a user gets after a repeat app-shell crash is recovered without the
 * document that caused it.
 *
 * A repeat crash arms tab-session-restore suppression, so the recovery mount
 * comes up with an empty workspace instead of reopening the crashing document.
 * With nothing said, that empty workspace is indistinguishable from the app
 * having forgotten the tab. This tells the user the recovery was deliberate: the
 * last document could not be restored, which is why nothing reopened.
 *
 * The copy resolves against the active locale at call time, which is why the `t`
 * macro is called here rather than hoisted to a module-load constant.
 */

import { t } from '@lingui/core/macro';
import { toast } from 'sonner';

/**
 * Shared id, so a recovery that fires the notice more than once — a StrictMode
 * double-invoke, or a second recovery later in the same session — replaces its
 * own notice instead of stacking a duplicate.
 */
const NOTICE_ID = 'ok-tab-session-restore-recovered';

export function showTabSessionRestoreRecoveryNotice(): void {
  toast(t`Your last open document couldn't be restored.`, {
    id: NOTICE_ID,
    description: t`The workspace opened without it so the app could start.`,
    // The user is recovering from a crash and may be looking away; a notice that
    // scrolled itself off would leave the empty workspace unexplained. The
    // toaster's close button is the way out.
    duration: Number.POSITIVE_INFINITY,
  });
}
