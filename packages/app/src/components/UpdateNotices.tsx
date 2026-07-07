// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * UpdateNotices — renderer side of the auto-updater notice surface.
 *
 * Mounts in the sidebar footer above the project switcher (see
 * `FileSidebar.tsx` → `SidebarFooter`). Reads live notices from a module-level store via
 * `useSyncExternalStore` — the IPC subscription lives OUTSIDE the React
 * tree (see `lib/update-notices-store.ts`) so renderer remounts (theme
 * toggle, sidebar resize, etc.) don't drop in-flight events.
 *
 * Rationale for sidebar placement over sonner overlays: the notices are
 * "permanent until clicked" — a stable anchored location fits that intent
 * better than a floating toast corner.
 */

import { useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { dismissNotice, getNoticesSnapshot, subscribeToNotices } from '@/lib/update-notices-store';
import { SubscribeCard } from './SubscribeCard';
import type { UpdateNotice } from './UpdateNotices.shared';

// Re-export the canonical copy + subscription surface for consumers that
// import from `./UpdateNotices` (tests, future callers). The subscription
// seams (`AddNoticeFn` / `DismissNoticeFn`) are intentionally NOT re-exported
// — their types are internal to `attachUpdateSubscribers` and not part of
// the public surface.
export {
  addSchemaIncompatibilityNotice,
  appendErrorDetail,
  attachUpdateSubscribers,
  INSTALL_FAILED_DOWNLOAD_ACTION,
  INSTALL_FAILED_RETRY_ACTION,
  installFailedBody,
  TOAST_A_ACTION,
  TOAST_A_ERROR_BODY,
  TOAST_A_PROGRESS_BODY,
  TOAST_B_ACTION,
  TOAST_C_ACTION,
  TOAST_C_BODY,
  TOAST_E_ACTION_RESET,
  TOAST_E_ERROR_BODY,
  toastABody,
  toastBBody,
  toastEBody,
  type UpdateNotice,
  WHATS_NEW_AUTO_DISMISS_MS,
} from './UpdateNotices.shared';

/**
 * Renders a single notice card. Default layout is a single row (body
 * text, action link, dismiss X). When `secondaryAction` is set the
 * card switches to a stacked layout: body + dismiss on top, both
 * action buttons inline below — accommodates Notice D's longer body
 * + two-button decision without the actions wrapping awkwardly.
 *
 * `notice.dismissible === false` drops the X entirely (both layouts) —
 * for terminal in-progress states like "Relaunching to install the
 * update…" there is nothing to dismiss. Exported for render-test visibility.
 */
export function NoticeCard({ notice, onDismiss }: { notice: UpdateNotice; onDismiss: () => void }) {
  const { t } = useLingui();
  const tone =
    notice.variant === 'error'
      ? 'border-destructive/60 bg-sidebar-accent/30 text-muted-foreground'
      : notice.variant === 'success'
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
        : 'border-sidebar-border bg-sidebar-accent/30 text-muted-foreground';
  const dismissButton =
    notice.dismissible === false ? null : (
      <Button
        variant="ghost"
        size="icon"
        className="size-5 shrink-0 text-muted-foreground hover:text-sidebar-foreground"
        aria-label={t`Dismiss notice`}
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="size-3" />
      </Button>
    );
  const actionDecoration =
    notice.variant === 'success' ? 'decoration-emerald-500/40' : 'decoration-muted-foreground/40';
  const actionButtonClass = `shrink-0 text-xs font-medium underline underline-offset-2 ${actionDecoration} hover:text-sidebar-foreground hover:decoration-sidebar-foreground`;

  if (notice.secondaryAction) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid={`update-notice-${notice.id}`}
        className={`flex flex-col gap-2 rounded-md border px-2 py-2 text-xs ${tone}`}
      >
        <div className="flex items-start gap-2">
          <span className="flex-1 leading-snug">{notice.body}</span>
          {dismissButton}
        </div>
        <div className="flex gap-3 pl-1">
          {notice.action ? (
            <button
              type="button"
              className={actionButtonClass}
              onClick={() => {
                notice.action?.onClick();
              }}
            >
              {notice.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className={actionButtonClass}
            onClick={() => {
              notice.secondaryAction?.onClick();
            }}
          >
            {notice.secondaryAction.label}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={`update-notice-${notice.id}`}
      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${tone}`}
    >
      <span className="flex-1 leading-snug">{notice.body}</span>
      {notice.action ? (
        <button
          type="button"
          className={actionButtonClass}
          onClick={() => {
            notice.action?.onClick();
          }}
        >
          {notice.action.label}
        </button>
      ) : null}
      {dismissButton}
    </div>
  );
}

/**
 * Pure selector: pick the single highest-priority (lowest `priority`
 * number) notice from the store. Multiple armed states are mutually
 * exclusive in practice (C = broken updater; A = pending install;
 * B = just updated — A wouldn't arm at the same time as B for the same
 * install), but the priority scheme handles the rare overlap cleanly.
 * Exported for unit-test visibility.
 */
export function pickActiveNotice(notices: readonly UpdateNotice[]): UpdateNotice | null {
  if (notices.length === 0) return null;
  let active = notices[0];
  if (!active) return null;
  for (let i = 1; i < notices.length; i++) {
    const n = notices[i];
    if (n && n.priority < active.priority) active = n;
  }
  return active;
}

/**
 * Mount point for update notices. Subscribes to the module-level store
 * via `useSyncExternalStore` and renders AT MOST ONE card — whichever
 * notice has the lowest priority number. Dismissing reveals the next
 * highest-priority notice if any are still armed. Safe to mount/unmount
 * freely — subscriptions live in the store, not here.
 */
export function UpdateNotices(): ReactNode {
  const notices = useSyncExternalStore(subscribeToNotices, getNoticesSnapshot, getNoticesSnapshot);
  const active = pickActiveNotice(notices);
  if (!active) return null;
  // A what's-new notice flagged `combinedSubscribe` renders as the combined
  // release-notes + subscribe card (which owns its own dismissal + the
  // subscribe-store side effects) instead of the plain one-line notice.
  if (active.combinedSubscribe && active.whatsNew) {
    return (
      <div data-testid="update-notices-list">
        <SubscribeCard
          version={active.whatsNew.version}
          onOpenReleaseNotes={() => active.action?.onClick()}
          onClose={() => dismissNotice(active.id)}
        />
      </div>
    );
  }
  return (
    <div data-testid="update-notices-list">
      <NoticeCard
        notice={active}
        onDismiss={() => {
          // Dismiss locally for immediate feedback; the notice's own side-effect
          // (e.g. what's-new telling main to clear every window) runs alongside.
          active.onDismiss?.();
          dismissNotice(active.id);
        }}
      />
    </div>
  );
}
