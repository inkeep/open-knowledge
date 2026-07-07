/**
 * UpdateNotices — pure subscription logic + canonical copy strings.
 *
 * Split out of `UpdateNotices.tsx` so the module-level store (`lib/update-
 * notices-store.ts`) can import it WITHOUT pulling in the React component
 * module (which would create an import cycle). The component module
 * imports these same exports for backward-compatible test visibility.
 */

import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/**
 * Canonical copy strings — single-card / minimal-wording shape, with
 * priority-based display (C > A > B; at most one active at a time).
 */
export const TOAST_A_ACTION = 'Relaunch';
export const TOAST_B_ACTION = 'Release notes';
export const TOAST_C_BODY = 'Updates paused';
export const TOAST_C_ACTION = 'Download';
export const TOAST_E_ACTION_RESET = 'Reset to defaults';

/**
 * In-progress body swapped onto Toast A the instant its Relaunch button is
 * clicked. In production, main tears down owned servers (SIGTERM + up to a
 * 10s grace) before `quitAndInstall`, so `relaunchNow()` doesn't resolve
 * before the window is destroyed — without an immediate swap the card sits
 * unchanged for seconds and the user can't tell their click registered.
 */
export const TOAST_A_PROGRESS_BODY = 'Relaunching to install the update…';

/**
 * Fallback notice shown when `bridge.update.relaunchNow()` IPC rejects —
 * wrong packaging, missing staging dir, Squirrel.Mac throwing. Without
 * this, the "Relaunch now" click would do nothing visible. Give the
 * user a recovery path.
 */
export const TOAST_A_ERROR_BODY = 'Relaunch failed — please restart manually';

/**
 * Body + action labels for the boot-detected failed-install notice — the
 * staged update did not take after a quit (e.g. Squirrel.Mac's post-quit
 * ShipIt never ran), detected at the next boot when the running version did
 * not reach the attempted one. Distinct from TOAST_A_ERROR_BODY (an in-session
 * relaunch error): this carries a two-action recovery — retry the still-staged
 * install, or fall back to a manual download.
 */
export function installFailedBody(version: string): string {
  return `Update to ${version} didn't install.`;
}
export const INSTALL_FAILED_RETRY_ACTION = 'Retry';
export const INSTALL_FAILED_DOWNLOAD_ACTION = 'Download manually';

/**
 * Fallback notice shown when the "Reset to defaults" button on Notice E
 * (the schema-incompatibility notice) rejects. Same reasoning as
 * TOAST_A_ERROR_BODY: the user clicked something, the system needs to
 * acknowledge the failure visibly so the click doesn't feel swallowed.
 */
export const TOAST_E_ERROR_BODY = 'Recovery action failed — please try again';

/**
 * Compose an error notice body that surfaces the underlying rejection
 * message when one is available. The IPC handlers in main throw
 * actionable messages (e.g. "Auto-updater is not available — please
 * restart the app") — without surfacing them, the user's retry would hide
 * the one detail that lets them recover. Non-Error rejections (string
 * throws, undefined) and empty messages fall back to the canonical body
 * alone.
 */
export function appendErrorDetail(base: string, err: unknown): string {
  const detail = err instanceof Error && err.message ? err.message : '';
  return detail ? `${base}: ${detail}` : base;
}

/**
 * Toast A body copy for a downloaded update. This is the pre-relaunch
 * notice, so name the version that will be installed when the app restarts.
 */
export function toastABody(version: string): string {
  return `Version ${version} ready to install`;
}

/**
 * Toast B body copy for a given version. Version is interpolated raw —
 * intentionally asymmetric with `releaseUrlFor` in `auto-updater.ts` which
 * percent-encodes. `version` comes from `app.getVersion()` (trusted), and
 * React renders it into a text node (XSS-safe). URL encoding at the URL
 * surface only. Do not "fix" the asymmetry.
 *
 * Revised to explicit "Version" wording so first-launch-post-update copy
 * matches the release notification language.
 */
export function toastBBody(version: string): string {
  return `Updated to Version ${version}`;
}

/**
 * Notice E body — refuse-downgrade warning shown at boot when the
 * persisted state was written by a newer build (typically a beta) that
 * bumped a schema version this build doesn't recognize. `currentBuild`
 * comes from main's `app.getVersion()` (trusted) and renders into a text
 * node (XSS-safe — same treatment as `toastBBody`). The schema version
 * numbers from the diagnostic are intentionally NOT exposed in the body
 * — they're internal versioning the user can't act on; the build version
 * gives them enough context to recognize the situation.
 *
 * Names "settings and recent projects" explicitly because the Reset
 * action wipes the entire AppState (full clear is the only mechanically-
 * safe choice when the persisted state was written by an unknown future
 * build — partial reset would leave us trusting field shapes we can't
 * verify). Without naming recent projects the user could click Reset
 * expecting only preferences to clear and lose their project history.
 */
export function toastEBody(currentBuild: string): string {
  return `Your settings and recent projects were saved by a newer build than this one (v${currentBuild}). Reset to defaults to continue.`;
}

/**
 * Public shape of a single rendered notice. `id` provides dedup across
 * repeat dispatches. `variant: 'error'` renders with a destructive-styled
 * border; the only caller today is the relaunch-failed fallback.
 * `variant: 'success'` renders with a green tone — the what's-new notice
 * uses it so "you just updated" reads differently from the gray "update
 * ready to install" card.
 *
 * `priority` drives single-card display: when multiple notices are armed,
 * the lowest-priority number wins (rendered alone). Lower = more urgent.
 *
 * `secondaryAction` is an optional second-button slot. NoticeCard switches
 * to a stacked layout when it's present. No notice currently uses it; it's
 * retained for future two-action notices.
 */
export interface UpdateNotice {
  id: string;
  body: string;
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  /**
   * Optional side-effect run when the card is dismissed via the X button, in
   * addition to removing it from the store. The what's-new notice uses this to
   * tell main so the dismissal propagates to every open window.
   */
  onDismiss?: () => void;
  variant?: 'info' | 'error' | 'success';
  priority: number;
  /**
   * Present on the what's-new notice: the update version + its release-notes
   * URL, carried structurally so a consumer can render a richer card (the
   * combined release-notes + subscribe card) without parsing the body string.
   */
  whatsNew?: { version: string; releaseUrl: string };
  /**
   * When true, this what's-new notice should render as the combined
   * release-notes + subscribe card rather than the plain one-line notice. Set
   * at creation when the subscribe prompt is eligible; the card owns its own
   * lifecycle (no auto-dismiss) — see `SubscribeCard`.
   */
  combinedSubscribe?: boolean;
  /**
   * When `false`, the card renders without the dismiss X. Reserved for
   * terminal in-progress states — the "Relaunching to install the update…"
   * card — where there is nothing to dismiss: the app is restarting and the
   * card disappears with it. Omitted (the default) renders the X as usual.
   */
  dismissible?: boolean;
}

/**
 * Priority scheme (lower = more urgent, shown first):
 *   0 — schema-incompat (E): "data was written by a newer build, decide"
 *   0 — stuck-hint (C): "updates broken, do something"
 *   1 — relaunch-error: error follow-up to A's Relaunch click
 *   2 — update-downloaded (A): "newer version ready, install it"
 *   3 — whats-new (B): "you just updated"
 *
 * E shares level 0 with stuck-hint. Practically these never co-arm at
 * the same instant: E fires once at module-load via `bridge.state.query`
 * if the boot guard stashed a diagnostic, while stuck-hint is push-driven
 * by main when an update check has been blocked for hours. If both did
 * arm, picking E first is correct — data integrity outranks "polling is
 * paused" — and the strict-`<` comparator's first-wins tie-break gives us
 * that ordering as long as the query resolves before stuck-hint dispatches.
 */
const PRIORITY_SCHEMA_INCOMPATIBILITY = 0;
const PRIORITY_STUCK_HINT = 0;
const PRIORITY_RELAUNCH_ERROR = 1;
const PRIORITY_UPDATE_DOWNLOADED = 2;
const PRIORITY_WHATS_NEW = 3;

/**
 * The what's-new notice (B) is purely informational — it confirms a
 * completed update and links to release notes. Unlike A/C/E it has no
 * pending decision behind it, so it self-dismisses after this window
 * rather than lingering until the user clicks the X. One minute is long
 * enough to read the line and click through, short enough not to clutter
 * the sidebar footer for the rest of the session.
 */
export const WHATS_NEW_AUTO_DISMISS_MS = 60_000;

/**
 * Testable seam — production wires this to the module-level store's
 * `addNotice`; tests pass a capturing stub. Idempotent on id collision
 * (update-in-place).
 */
type AddNoticeFn = (notice: UpdateNotice) => void;

/**
 * Testable seam for dismissing a notice by id from outside the store.
 * Used by the Toast A onClick handler to remove the card the moment
 * `relaunchNow()` resolves — gives visible feedback in dev (where
 * `quitAndInstall` is a no-op) and is a harmless no-op in production
 * (the app is about to quit anyway, taking the card with it).
 */
type DismissNoticeFn = (id: string) => void;

/**
 * Pure subscription logic. Attach all update subscribers on the given
 * bridge + return a single unsubscribe closure that detaches all of
 * them. Testable without a React renderer — accepts an `addNotice`
 * stub.
 *
 * Toast A's Relaunch onClick + Notice D's Continue/Stay onClicks await
 * their respective bridge IPC promises and surface an error notice on
 * rejection (same pattern, different copy). `shell.openExternal` calls
 * stay fire-and-forget — their URLs are hardcoded in main and pass the
 * asset allowlist by construction.
 *
 * `autoDismissMs` is the what's-new self-dismiss window — injectable so
 * tests can exercise the timer without a real 60s wait. The returned
 * unsubscribe closure clears any pending auto-dismiss timer so a detach
 * can't fire a dismiss afterward.
 */
export function attachUpdateSubscribers(
  bridge: OkDesktopBridge,
  addNotice: AddNoticeFn,
  dismissNotice: DismissNoticeFn = () => {},
  autoDismissMs: number = WHATS_NEW_AUTO_DISMISS_MS,
  // Injected subscribe-prompt gate. Default is a no-op (plain what's-new notice)
  // so tests and the plain path stay untouched; the store wires the real gate.
  subscribeCombined: {
    isEligible: (version: string) => boolean;
    onShown: (version: string) => void;
  } = { isEligible: () => false, onShown: () => {} },
): () => void {
  const unsubscribers: Array<() => void> = [];
  const autoDismissTimers = new Set<ReturnType<typeof setTimeout>>();

  // Stable id (no version suffix) so a second download landing later in
  // the same session — e.g. beta.18 staged, then beta.19 cut and
  // discovered by the periodic check — REPLACES the prior notice
  // in-place via the store's `addNotice` dedup. A version-suffixed id
  // would accumulate a second notice at the same priority, and
  // `pickActiveNotice`'s strict-`<` tie-break keeps showing the older
  // version while Squirrel installs the newer staged update on
  // relaunch (the user-visible "toast says beta.18, relaunch lands on
  // beta.19" symptom). Shared by the onUpdateDownloaded arm, its local
  // Relaunch-click swap, AND the onUpdateRelaunching cross-window swap —
  // all three must target the same store entry to replace in-place.
  const downloadedNoticeId = 'update-downloaded';

  unsubscribers.push(
    bridge.onUpdateDownloaded(({ version }) => {
      const noticeId = downloadedNoticeId;

      // The armed "ready to install" card. Factored into a local so the
      // relaunch-error path can restore it (re-showing the Relaunch button
      // for a retry) after the click swapped it for the in-progress card.
      const armReadyNotice = () => {
        addNotice({
          id: noticeId,
          body: toastABody(version),
          priority: PRIORITY_UPDATE_DOWNLOADED,
          action: {
            label: TOAST_A_ACTION,
            onClick: () => {
              // Immediate feedback the instant the click lands: replace the
              // card in-place (same id) with a button-less in-progress card.
              // Production relaunch tears down owned servers before
              // `quitAndInstall`, so `relaunchNow()` can't resolve before the
              // window dies — this swap is the only signal the click landed,
              // and dropping the action button also kills the double-click.
              // `dismissible: false` drops the X too: this is a terminal
              // state with nothing to dismiss — the card goes away when the
              // app restarts, so a manual close would only hide live progress.
              addNotice({
                id: noticeId,
                body: TOAST_A_PROGRESS_BODY,
                priority: PRIORITY_UPDATE_DOWNLOADED,
                dismissible: false,
              });
              bridge.update.relaunchNow().then(
                () => {
                  // Production: main quits the app before this resolves, so
                  // the dismiss is a no-op (window dies with the app).
                  // Dev: quitAndInstall silently no-ops in MacUpdater because
                  // Squirrel.Mac can't replace an unpackaged `.app`, so the
                  // app stays running — dismissing the in-progress card gives
                  // the user visible closure that their click was received.
                  dismissNotice(noticeId);
                },
                (err: unknown) => {
                  // Relaunch failed — the app is NOT quitting. Restore the
                  // armed card so Relaunch can be retried, then surface the
                  // failure. The error id is version-keyed (not the stable
                  // `update-downloaded`): the per-closure version captured at
                  // onClick time stays observable through this id (the
                  // closure-freshness test depends on that), and a second
                  // failed relaunch across versions accumulates a second
                  // notice at this priority — accepted because error notices
                  // have no action button and distinct attempts may carry
                  // distinct error messages worth surfacing.
                  armReadyNotice();
                  addNotice({
                    id: `relaunch-error-${version}`,
                    body: appendErrorDetail(TOAST_A_ERROR_BODY, err),
                    variant: 'error',
                    priority: PRIORITY_RELAUNCH_ERROR,
                  });
                },
              );
            },
          },
        });
      };

      armReadyNotice();
    }),
  );

  unsubscribers.push(
    bridge.onUpdateRelaunching(() => {
      // Another window's "Relaunch" click committed in main, which fans this
      // out to every window. Swap our "…ready to install [Relaunch]" banner to
      // the same button-less, non-dismissible in-progress card the clicked
      // window already shows locally — so all windows show consistent feedback
      // during the up-to-10s server teardown before `quitAndInstall`, and the
      // Relaunch button can't be fired a second time from another window.
      // Plain in-place swap on the shared id (no IPC back to main — this IS the
      // echo, so it can't loop). The payload version is unused: the body is
      // static and the swap is unconditional (the app is committed to
      // relaunching regardless of which version this window had staged).
      // Not a dead end: if the relaunch fails in main (sync throw, async
      // updater error, or no-quit watchdog), main re-broadcasts
      // ok:update:downloaded, whose armed banner replaces this card in place
      // via the same id — so a failed relaunch can't strand non-clicked
      // windows on a button-less, non-dismissible card.
      addNotice({
        id: downloadedNoticeId,
        body: TOAST_A_PROGRESS_BODY,
        priority: PRIORITY_UPDATE_DOWNLOADED,
        dismissible: false,
      });
    }),
  );

  unsubscribers.push(
    bridge.onUpdateRelaunchFailed(({ version, message, downloadUrl }) => {
      // Boot-detected failed install (a clean quit whose post-quit install
      // never ran) arrives with a `downloadUrl` — main re-armed
      // versionPendingInstall, so show the richer two-action recovery card:
      // Retry re-triggers the still-staged install through the relaunch-now
      // gate, Download manually opens the release page. The in-session
      // async/watchdog/sync-throw failures omit `downloadUrl` and keep the
      // plain relaunch-error message below.
      if (downloadUrl) {
        const failedId = `install-failed-${version}`;
        const armFailedNotice = (): void => {
          addNotice({
            id: failedId,
            body: installFailedBody(version),
            variant: 'error',
            priority: PRIORITY_RELAUNCH_ERROR,
            action: {
              label: INSTALL_FAILED_RETRY_ACTION,
              onClick: () => {
                bridge.update.relaunchNow().then(
                  () => {
                    // Dev no-op resolves immediately; in production the app is
                    // quitting and the card dies with the window.
                    dismissNotice(failedId);
                  },
                  (err: unknown) => {
                    // Retry rejected in main (e.g. versionPendingInstall was
                    // cleared, or the persist gate failed). Re-arm the card so
                    // Download manually stays reachable — a conscious divergence
                    // from Toast A's user-facing appendErrorDetail: here the
                    // two-action recovery card is already the error surface, so
                    // we keep it and log the reason renderer-side for diagnostics
                    // rather than rewriting the body.
                    console.warn('[update-notice] install-failed retry rejected', err);
                    armFailedNotice();
                  },
                );
              },
            },
            secondaryAction: {
              label: INSTALL_FAILED_DOWNLOAD_ACTION,
              onClick: () => {
                void bridge.shell.openExternal(downloadUrl);
              },
            },
          });
        };
        armFailedNotice();
        return;
      }
      // A committed relaunch failed (async updater error / no-quit watchdog /
      // sync throw). Main already re-broadcast ok:update:downloaded to re-arm
      // the banner; this surfaces the failure itself. Same version-keyed id
      // as the clicked window's rejection-path notice, so the two routes
      // dedupe to one card on the window that clicked, and body formatting
      // matches appendErrorDetail's `base: detail` shape.
      addNotice({
        id: `relaunch-error-${version}`,
        body: message ? `${TOAST_A_ERROR_BODY}: ${message}` : TOAST_A_ERROR_BODY,
        variant: 'error',
        priority: PRIORITY_RELAUNCH_ERROR,
      });
    }),
  );

  unsubscribers.push(
    bridge.onWhatsNew(({ version, releaseUrl }) => {
      // Combined path: when the subscribe prompt is eligible, render the
      // what's-new content INSIDE the "Stay in the loop" card instead of the
      // plain notice. Two deliberate differences from the plain path:
      //   1. A distinct notice id (`whats-new-combined-`) so the dismissWhatsNew
      //      echo — which targets `whats-new-${version}` — can't remove this
      //      card out from under the user mid-session.
      //   2. No auto-dismiss timer; the card stays until the user subscribes or
      //      dismisses (SubscribeCard owns its lifecycle).
      // We still tell main the version is seen immediately, so a close+reopen
      // does NOT bring the combined card back (the card must not re-nag).
      if (subscribeCombined.isEligible(version)) {
        subscribeCombined.onShown(version);
        addNotice({
          id: `whats-new-combined-${version}`,
          body: toastBBody(version),
          variant: 'success',
          priority: PRIORITY_WHATS_NEW,
          combinedSubscribe: true,
          whatsNew: { version, releaseUrl },
          action: {
            label: TOAST_B_ACTION,
            onClick: () => {
              void bridge.shell.openExternal(releaseUrl);
            },
          },
        });
        void bridge.update.dismissWhatsNew(version);
        return;
      }

      const noticeId = `whats-new-${version}`;
      addNotice({
        id: noticeId,
        body: toastBBody(version),
        // Green tone differentiates "you just updated" from the gray
        // "Version X ready to install" card — same footer slot, opposite
        // meaning (done vs. action pending).
        variant: 'success',
        priority: PRIORITY_WHATS_NEW,
        action: {
          label: TOAST_B_ACTION,
          onClick: () => {
            void bridge.shell.openExternal(releaseUrl);
          },
        },
        // Dismissing in one window clears the same FYI everywhere: tell main,
        // which re-broadcasts to every window. The echo lands back here as a
        // plain store dismiss (no `onDismiss`), so it can't loop.
        onDismiss: () => {
          void bridge.update.dismissWhatsNew(version);
        },
      });
      // Self-dismiss after the window — B confirms a finished update and
      // has no pending decision, so it shouldn't linger all session. A
      // user-clicked X (or dismiss-by-id) before the timer fires just
      // makes the eventual `dismissNotice` a no-op (id already gone). The
      // first window's timer to fire also notifies main, so the other windows
      // clear in lockstep and main stops offering the notice to windows opened
      // later.
      const timer = setTimeout(() => {
        autoDismissTimers.delete(timer);
        dismissNotice(noticeId);
        void bridge.update.dismissWhatsNew(version);
      }, autoDismissMs);
      autoDismissTimers.add(timer);
    }),
  );

  unsubscribers.push(
    bridge.onWhatsNewDismissed(({ version }) => {
      // Plain store dismiss — NOT the notice's `onDismiss`. This is the echo of
      // another window's dismissal (or our own, bounced back through main);
      // routing it through `onDismiss` would re-notify main and loop. No-op when
      // the notice is already gone.
      dismissNotice(`whats-new-${version}`);
    }),
  );

  unsubscribers.push(
    bridge.onUpdateStuckHint(({ downloadUrl }) => {
      addNotice({
        id: 'update-stuck-hint',
        body: TOAST_C_BODY,
        priority: PRIORITY_STUCK_HINT,
        action: {
          label: TOAST_C_ACTION,
          onClick: () => {
            void bridge.shell.openExternal(downloadUrl);
          },
        },
      });
    }),
  );

  return () => {
    for (const off of unsubscribers) off();
    for (const timer of autoDismissTimers) clearTimeout(timer);
    autoDismissTimers.clear();
  };
}

/**
 * Diagnostic shape carried by `OkStateSnapshot.schemaIncompatibility`.
 * Derived from the already-imported `OkDesktopBridge` so a future field
 * addition on the bridge automatically widens this type — avoiding the
 * silent drift the inline-interface form had (TypeScript's structural
 * typing wouldn't catch a maintainer adding a field to the bridge but
 * forgetting it here).
 */
type SchemaIncompatibilityDiagnostic = NonNullable<
  Awaited<ReturnType<OkDesktopBridge['state']['query']>>['schemaIncompatibility']
>;

/**
 * One-shot helper — emits Notice E (refuse-downgrade UX) when the boot
 * guard detected a future-build state. Called from
 * `installUpdateNoticesBridge` after `bridge.state.query()` resolves with
 * a non-null `schemaIncompatibility`.
 *
 * The single "Reset to defaults" action wipes AppState via
 * `state.resetIncompatible` — a full `emptyState()` clear is the only
 * mechanically-safe choice when the persisted state was written by an
 * unknown future build. Dismisses on success; surfaces a generic error
 * notice on rejection so the user's click isn't swallowed.
 *
 * Notice ID keys off `persistedSchemaVersion` so different incompatible
 * versions get distinct ids; the same diagnostic fired twice (e.g. two
 * windows both querying state) dedups via list-level update-in-place.
 */
export function addSchemaIncompatibilityNotice(
  bridge: OkDesktopBridge,
  diagnostic: SchemaIncompatibilityDiagnostic,
  addNotice: AddNoticeFn,
  dismissNotice: DismissNoticeFn = () => {},
): void {
  const noticeId = `schema-incompatibility-${diagnostic.persistedSchemaVersion}`;
  const errorId = `schema-incompatibility-error-${diagnostic.persistedSchemaVersion}`;
  const reportError = (err: unknown) => {
    // Dismiss the parent notice so the error notice (same priority) wins
    // the active-notice selection — pickActiveNotice uses strict `<` and
    // first-wins on ties.
    dismissNotice(noticeId);
    addNotice({
      id: errorId,
      body: appendErrorDetail(TOAST_E_ERROR_BODY, err),
      variant: 'error',
      priority: PRIORITY_SCHEMA_INCOMPATIBILITY,
    });
  };
  addNotice({
    id: noticeId,
    body: toastEBody(diagnostic.currentBuild),
    priority: PRIORITY_SCHEMA_INCOMPATIBILITY,
    action: {
      label: TOAST_E_ACTION_RESET,
      onClick: () => {
        bridge.state.resetIncompatible().then(() => {
          dismissNotice(noticeId);
        }, reportError);
      },
    },
  });
}
