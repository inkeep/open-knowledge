import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export const TOAST_A_ACTION = 'Relaunch';
export const TOAST_B_ACTION = 'Release notes';
export const TOAST_C_BODY = 'Updates paused';
export const TOAST_C_ACTION = 'Download';
export const TOAST_E_ACTION_RESET = 'Reset to defaults';

export const TOAST_A_PROGRESS_BODY = 'Relaunching to install the update…';

export const TOAST_A_ERROR_BODY = 'Relaunch failed — please restart manually';

export function installFailedBody(version: string): string {
  return `Update to ${version} didn't install.`;
}
export const INSTALL_FAILED_RETRY_ACTION = 'Retry';
export const INSTALL_FAILED_DOWNLOAD_ACTION = 'Download manually';

export const TOAST_E_ERROR_BODY = 'Recovery action failed — please try again';

export function appendErrorDetail(base: string, err: unknown): string {
  const detail = err instanceof Error && err.message ? err.message : '';
  return detail ? `${base}: ${detail}` : base;
}

export function toastABody(version: string): string {
  return `Version ${version} ready to install`;
}

export function toastBBody(version: string): string {
  return `Updated to Version ${version}`;
}

export function toastEBody(currentBuild: string): string {
  return `Your settings and recent projects were saved by a newer build than this one (v${currentBuild}). Reset to defaults to continue.`;
}

export interface UpdateNotice {
  id: string;
  body: string;
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  variant?: 'info' | 'error' | 'success';
  priority: number;
  dismissible?: boolean;
}

const PRIORITY_SCHEMA_INCOMPATIBILITY = 0;
const PRIORITY_STUCK_HINT = 0;
const PRIORITY_RELAUNCH_ERROR = 1;
const PRIORITY_UPDATE_DOWNLOADED = 2;
const PRIORITY_WHATS_NEW = 3;

export const WHATS_NEW_AUTO_DISMISS_MS = 60_000;

type AddNoticeFn = (notice: UpdateNotice) => void;

type DismissNoticeFn = (id: string) => void;

export function attachUpdateSubscribers(
  bridge: OkDesktopBridge,
  addNotice: AddNoticeFn,
  dismissNotice: DismissNoticeFn = () => {},
  autoDismissMs: number = WHATS_NEW_AUTO_DISMISS_MS,
): () => void {
  const unsubscribers: Array<() => void> = [];
  const autoDismissTimers = new Set<ReturnType<typeof setTimeout>>();

  const downloadedNoticeId = 'update-downloaded';

  unsubscribers.push(
    bridge.onUpdateDownloaded(({ version }) => {
      const noticeId = downloadedNoticeId;

      const armReadyNotice = () => {
        addNotice({
          id: noticeId,
          body: toastABody(version),
          priority: PRIORITY_UPDATE_DOWNLOADED,
          action: {
            label: TOAST_A_ACTION,
            onClick: () => {
              addNotice({
                id: noticeId,
                body: TOAST_A_PROGRESS_BODY,
                priority: PRIORITY_UPDATE_DOWNLOADED,
                dismissible: false,
              });
              bridge.update.relaunchNow().then(
                () => {
                  dismissNotice(noticeId);
                },
                (err: unknown) => {
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
                    dismissNotice(failedId);
                  },
                  (err: unknown) => {
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
      const noticeId = `whats-new-${version}`;
      addNotice({
        id: noticeId,
        body: toastBBody(version),
        variant: 'success',
        priority: PRIORITY_WHATS_NEW,
        action: {
          label: TOAST_B_ACTION,
          onClick: () => {
            void bridge.shell.openExternal(releaseUrl);
          },
        },
        onDismiss: () => {
          void bridge.update.dismissWhatsNew(version);
        },
      });
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

type SchemaIncompatibilityDiagnostic = NonNullable<
  Awaited<ReturnType<OkDesktopBridge['state']['query']>>['schemaIncompatibility']
>;

export function addSchemaIncompatibilityNotice(
  bridge: OkDesktopBridge,
  diagnostic: SchemaIncompatibilityDiagnostic,
  addNotice: AddNoticeFn,
  dismissNotice: DismissNoticeFn = () => {},
): void {
  const noticeId = `schema-incompatibility-${diagnostic.persistedSchemaVersion}`;
  const errorId = `schema-incompatibility-error-${diagnostic.persistedSchemaVersion}`;
  const reportError = (err: unknown) => {
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
