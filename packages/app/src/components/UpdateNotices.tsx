// oxlint-disable ok/no-raw-html-interactive-element -- pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-raw-html-interactive-element

import { useLingui } from '@lingui/react/macro';
import { TriangleAlertIcon, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { dismissNotice, getNoticesSnapshot, subscribeToNotices } from '@/lib/update-notices-store';
import { SubscribeCard } from './SubscribeCard';
import type { UpdateNotice } from './UpdateNotices.shared';

export {
  addSchemaIncompatibilityNotice,
  appendErrorDetail,
  attachUpdateSubscribers,
  INSTALL_FAILED_DOWNLOAD_ACTION,
  INSTALL_FAILED_RETRY_ACTION,
  installFailedBody,
  TOAST_A_ACTION,
  TOAST_A_ERROR_BODY,
  TOAST_A_FETCHING_LATEST_BODY,
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

export function NoticeCard({ notice, onDismiss }: { notice: UpdateNotice; onDismiss: () => void }) {
  const { t } = useLingui();
  const tone =
    notice.variant === 'error'
      ? 'border-warning/40 text-warning'
      : notice.variant === 'success'
        ? 'border-success/40 text-success'
        : 'text-muted-foreground';
  const dismissTone =
    notice.variant === 'error'
      ? 'text-warning hover:bg-warning/15 hover:text-warning dark:hover:bg-warning/15'
      : 'text-muted-foreground hover:text-sidebar-foreground';
  const dismissButton =
    notice.dismissible === false ? null : (
      <Button
        variant="ghost"
        size="icon"
        className={`size-5 shrink-0 ${dismissTone}`}
        aria-label={t`Dismiss notice`}
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="size-3" />
      </Button>
    );
  const warningIcon =
    notice.variant === 'error' ? (
      <TriangleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
    ) : null;
  const actionTone =
    notice.variant === 'error'
      ? 'decoration-warning/40 hover:text-sidebar-foreground hover:decoration-sidebar-foreground'
      : notice.variant === 'success'
        ? 'decoration-success/40 hover:text-sidebar-foreground hover:decoration-sidebar-foreground'
        : 'decoration-muted-foreground/40 hover:text-sidebar-foreground hover:decoration-sidebar-foreground';
  const actionButtonClass = `shrink-0 text-xs font-medium underline underline-offset-2 ${actionTone}`;

  if (notice.secondaryAction) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid={`update-notice-${notice.id}`}
        className={`floating-card-surface relative flex w-fit max-w-full flex-col gap-2 py-2 ps-3 ${dismissButton ? 'pe-9' : 'pe-3'} text-xs ${tone}`}
      >
        <div className="flex items-start gap-2">
          {warningIcon}
          <span className="min-w-0 flex-1 leading-snug wrap-anywhere">{notice.body}</span>
        </div>
        {dismissButton ? <div className="absolute end-1.5 top-1.5">{dismissButton}</div> : null}
        <div className={`flex gap-3 ${warningIcon ? 'ps-5.5' : 'ps-1'}`}>
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
      className={`floating-card-surface relative flex w-fit max-w-full items-center gap-3 py-2 ps-3 ${dismissButton ? 'pe-9' : 'pe-3'} text-xs ${tone}`}
    >
      {warningIcon}
      <span className="min-w-0 flex-1 leading-snug wrap-anywhere">{notice.body}</span>
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
      {dismissButton ? <div className="absolute end-1.5 top-1.5">{dismissButton}</div> : null}
    </div>
  );
}

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

export function UpdateNotices(): ReactNode {
  const notices = useSyncExternalStore(subscribeToNotices, getNoticesSnapshot, getNoticesSnapshot);
  const active = pickActiveNotice(notices);
  if (!active) return null;
  if (active.combinedSubscribe && active.whatsNew) {
    return (
      <div data-testid="update-notices-list" className="shrink-0">
        <SubscribeCard
          version={active.whatsNew.version}
          onOpenReleaseNotes={() => active.action?.onClick()}
          onClose={() => dismissNotice(active.id)}
        />
      </div>
    );
  }
  return (
    <div data-testid="update-notices-list" className="shrink-0">
      <NoticeCard
        notice={active}
        onDismiss={() => {
          active.onDismiss?.();
          dismissNotice(active.id);
        }}
      />
    </div>
  );
}
