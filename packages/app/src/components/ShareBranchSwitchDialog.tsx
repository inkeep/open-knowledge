
import { Trans, useLingui } from '@lingui/react/macro';
import { GitBranch, Loader2, MapPin } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import { ShareMetadataRows } from '@/components/share-metadata-rows';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type OkDesktopBridge,
  type OkShareReceivedPayload,
  shareTargetPath,
} from '@/lib/desktop-bridge-types';
import {
  applyBranchInfo,
  applyCheckoutOutcome,
  type BranchSwitchDialogState,
  type CheckoutSideEffectReason,
  formatCurrentLabel,
  initialBranchSwitchState,
  markSwitching,
  selectBranchSwitchVariant,
} from '@/lib/share/branch-switch-flow';
import { formatReceiveLog } from '@/lib/share/receive-flow';
import { type ShareReceiveStore, shareReceiveStore } from '@/lib/share/receive-store';

export interface ShareBranchSwitchDialogProps {
  bridge: OkDesktopBridge;
  store?: ShareReceiveStore;
}

type ProjectBranchSwitchPayload = Extract<
  OkShareReceivedPayload,
  { kind: 'project-branch-switch' }
>;

function isBranchSwitchPayload(
  payload: OkShareReceivedPayload | null,
): payload is ProjectBranchSwitchPayload {
  return payload !== null && payload.kind === 'project-branch-switch';
}

export function ShareBranchSwitchDialog({
  bridge,
  store = shareReceiveStore,
}: ShareBranchSwitchDialogProps) {
  const { t } = useLingui();
  const payload = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
  const [branchSwitchState, setBranchSwitchState] =
    useState<BranchSwitchDialogState>(initialBranchSwitchState);
  const branchInfoStartedRef = useRef(false);
  const awaitBranchSwitchedStartedRef = useRef(false);

  const active = isBranchSwitchPayload(payload) ? payload : null;
  const targetNoun = active?.share.target.kind === 'folder' ? t`folder` : t`document`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: payload is the reset trigger; effect body only resets state.
  useEffect(() => {
    setBranchSwitchState(initialBranchSwitchState);
    branchInfoStartedRef.current = false;
    awaitBranchSwitchedStartedRef.current = false;
  }, [payload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref-guarded single-fire; unstable bridge identity would re-trigger.
  useEffect(() => {
    if (!active) return;
    if (branchInfoStartedRef.current) return;
    branchInfoStartedRef.current = true;
    void bridge.project
      .fetchBranchInfo({
        projectPath: active.projectPath,
        branch: active.share.branch,
        kind: active.share.target.kind,
        path: shareTargetPath(active.share.target),
      })
      .then((info) => {
        setBranchSwitchState((prev) => applyBranchInfo(prev, info));
      })
      .catch((err) => {
        console.warn(
          '[receive] branch-info-fetch-failed',
          err instanceof Error ? err.message : err,
        );
        setBranchSwitchState((prev) => applyBranchInfo(prev, null));
      });
  }, [active]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: phase-keyed single-fire; bridge identity churns every parent render.
  useEffect(() => {
    if (branchSwitchState.phase !== 'awaiting-cc1-recycle') return;
    if (!active) return;
    const shareBranch = active.share.branch;
    if (!shareBranch) {
      store.dismiss();
      return;
    }
    if (awaitBranchSwitchedStartedRef.current) return;
    awaitBranchSwitchedStartedRef.current = true;
    let cancelled = false;
    void bridge.project
      .awaitBranchSwitched({
        projectPath: active.projectPath,
        branch: shareBranch,
        timeoutMs: 30_000,
      })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          console.log(
            formatReceiveLog({
              branch_dialog_action: 'branch-switch-complete',
              branch: shareBranch,
            }),
          );
          void bridge.project
            .open({
              path: active.projectPath,
              target: 'new-window',
              entryPoint: 'share-receive',
              pendingDeepLinkTarget: {
                kind: active.share.target.kind,
                path: shareTargetPath(active.share.target),
              },
              pendingBranch: shareBranch,
            })
            .catch((err) => {
              console.warn(
                '[receive] warm-focus-dispatch-failed branch_action=switch',
                err instanceof Error ? err.message : err,
              );
              toast.error(
                t`Branch switched but the ${targetNoun} could not be opened — try navigating to it manually.`,
              );
            });
          store.dismiss();
          return;
        }
        console.log(
          formatReceiveLog({
            branch_dialog_action: 'branch-switch-timeout',
            branch: shareBranch,
          }),
        );
        toast.error(t`Branch switch timed out — try opening the ${targetNoun} manually.`);
        store.dismiss();
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(
          '[receive] awaitBranchSwitched rejected',
          err instanceof Error ? err.message : err,
        );
        toast.error(t`Branch switch failed — try opening the ${targetNoun} manually.`);
        store.dismiss();
      });
    return () => {
      cancelled = true;
    };
  }, [branchSwitchState.phase, active]);

  if (!active) return null;

  const { share, projectPath, currentBranch: payloadCurrentBranch } = active;
  const shareBranch = share.branch;

  function handleSwitch(): void {
    if (branchSwitchState.phase !== 'ready') return;
    const variant = selectBranchSwitchVariant(branchSwitchState.info);
    if (!variant.switchEnabled) return;
    console.log(
      formatReceiveLog({
        branch_dialog_action: 'switch',
        branch_action: 'switch',
        branch: shareBranch,
      }),
    );
    setBranchSwitchState((prev) => markSwitching(prev, shareTargetPath(share.target)));
    void bridge.project
      .runCheckout({ projectPath, branch: shareBranch })
      .then((response) => {
        let toastReason: CheckoutSideEffectReason | null = null;
        let shouldDismiss = false;
        setBranchSwitchState((prev) => {
          const { state: next, sideEffect } = applyCheckoutOutcome(prev, response);
          if (sideEffect) {
            toastReason = sideEffect.reason;
            shouldDismiss = next.phase === 'dismissed';
          }
          return next;
        });
        if (toastReason === 'branch-not-found') {
          toast.error(t`Branch ${shareBranch} no longer exists on the remote.`);
        } else if (toastReason === 'fetch-failed') {
          toast.error(t`Could not fetch branch. Check your connection.`);
        } else if (toastReason === 'checkout-failed' || toastReason === 'proxy-null') {
          toast.error(t`Could not switch to ${shareBranch}. Try switching manually.`);
        }
        if (shouldDismiss) store.dismiss();
      })
      .catch((err) => {
        console.warn(
          '[receive] runCheckout rejected branch_action=switch',
          err instanceof Error ? err.message : err,
        );
        setBranchSwitchState((prev) => applyCheckoutOutcome(prev, null).state);
        toast.error(t`Could not switch to ${shareBranch}. Try switching manually.`);
      });
  }

  function handleOpenCurrent(): void {
    console.log(
      formatReceiveLog({
        branch_dialog_action: 'open-current',
        branch: shareBranch,
      }),
    );
    void bridge.project
      .open({
        path: projectPath,
        target: 'new-window',
        entryPoint: 'share-receive',
        pendingDeepLinkTarget: { kind: share.target.kind, path: shareTargetPath(share.target) },
      })
      .catch((err) => {
        console.warn(
          '[receive] warm-focus-dispatch-failed branch_action=open-current',
          err instanceof Error ? err.message : err,
        );
        toast.error(t`The ${targetNoun} could not be opened — try navigating to it manually.`);
      });
    store.dismiss();
  }

  function handlePivot(): void {
    if (branchSwitchState.phase !== 'branch-in-other-worktree') return;
    const target = branchSwitchState.otherWorktreePath;
    console.log(
      formatReceiveLog({
        branch_dialog_action: 'pivot-to-other-worktree',
        branch: shareBranch,
      }),
    );
    void bridge.project
      .open({
        path: target,
        target: 'new-window',
        entryPoint: 'share-receive',
        pendingDeepLinkTarget: { kind: share.target.kind, path: shareTargetPath(share.target) },
        pendingBranch: shareBranch,
      })
      .catch((err) => {
        console.warn(
          '[receive] pivot-open-failed branch_action=pivot-to-other-worktree',
          err instanceof Error ? err.message : err,
        );
        toast.error(t`Could not open ${target}. Try opening it manually.`);
      });
    store.dismiss();
  }

  function handleCancel(): void {
    console.log(formatReceiveLog({ branch_dialog_action: 'cancel' }));
    store.dismiss();
  }

  const variant =
    branchSwitchState.phase === 'ready' || branchSwitchState.phase === 'switching'
      ? selectBranchSwitchVariant(branchSwitchState.info)
      : null;
  const currentLabel =
    branchSwitchState.phase === 'ready' || branchSwitchState.phase === 'switching'
      ? formatCurrentLabel(branchSwitchState.info)
      : (payloadCurrentBranch ?? 'HEAD');
  const switching =
    branchSwitchState.phase === 'switching' || branchSwitchState.phase === 'awaiting-cc1-recycle';
  const openCurrentLabel = t`Open in current branch`;
  const switchLabel = t`Open in ${shareBranch}`;
  const conflictListId = 'share-receive-branch-conflict-files';
  const isLoading = branchSwitchState.phase === 'loading';
  const isError = branchSwitchState.phase === 'error';
  return (
    <DialogRoot
      open={true}
      onOpenChange={(open) => {
        if (!open) handleCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-xl"
        data-testid="share-branch-switch-dialog"
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Open shared {targetNoun}</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>
              {share.owner}/{share.repo} — {shareTargetPath(share.target)}
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="mb-4">
            <ShareMetadataRows
              owner={share.owner}
              repo={share.repo}
              path={shareTargetPath(share.target)}
              kind={share.target.kind}
              branch={share.branch}
              testId="share-branch-switch-metadata"
              branchTestId="share-branch-switch-metadata-branch"
            />
          </div>
          {branchSwitchState.phase === 'branch-in-other-worktree' ? (
            <div
              className="text-sm text-muted-foreground"
              data-testid="share-branch-switch-in-other-worktree"
            >
              <p className="leading-6">
                <Trans>
                  Branch{' '}
                  <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                    {shareBranch}
                  </code>{' '}
                  is checked out in:
                </Trans>
              </p>
              <p
                className="mt-2 break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground/80"
                data-testid="share-branch-switch-in-other-worktree-path"
              >
                {branchSwitchState.otherWorktreePath}
              </p>
            </div>
          ) : isLoading ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="share-branch-switch-loading"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <Trans>Loading branch state</Trans>
            </p>
          ) : isError ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                Could not read branch state for this project. Close this dialog and open the share
                link again.
              </Trans>
            </p>
          ) : variant?.kind === 'D' ? (
            <p className="text-sm leading-6 text-muted-foreground">
              <Trans>
                This {targetNoun} only exists on branch{' '}
                <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                  {shareBranch}
                </code>
                . You have uncommitted changes that prevent switching. Commit or stash your changes,
                then open the share link again.
              </Trans>
            </p>
          ) : variant?.kind === 'B' ? (
            <p className="text-sm leading-6 text-muted-foreground">
              <Trans>
                This {targetNoun} was shared from branch{' '}
                <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                  {shareBranch}
                </code>
                . It doesn't exist on your current branch (
                <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                  {currentLabel}
                </code>
                ).
              </Trans>
            </p>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              <Trans>
                This {targetNoun} was shared from branch{' '}
                <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                  {shareBranch}
                </code>
                . You're currently on{' '}
                <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                  {currentLabel}
                </code>
                .
              </Trans>
            </p>
          )}
          {variant && !variant.switchEnabled && variant.conflictingFiles.length > 0 ? (
            <div
              className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-1sm"
              data-testid="share-branch-switch-conflict"
            >
              <p className="font-medium text-foreground/90">
                <Trans>Commit or stash changes to switch:</Trans>
              </p>
              <ul
                id={conflictListId}
                className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground"
              >
                {variant.conflictingFiles.map((file) => (
                  <li key={file}>
                    <code className="text-foreground/80">{file}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {switching ? (
            <p
              className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="share-branch-switch-switching"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <Trans>Switching branches</Trans>
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            className="font-mono uppercase"
            onClick={handleCancel}
            data-testid="share-branch-switch-cancel"
          >
            <Trans>Cancel</Trans>
          </Button>
          {branchSwitchState.phase === 'branch-in-other-worktree' ? (
            <Button onClick={handlePivot} data-testid="share-branch-switch-in-other-worktree-pivot">
              <Trans>Open that worktree instead</Trans>
            </Button>
          ) : (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:gap-2">
              {variant?.openCurrentEnabled ? (
                <Button
                  variant="outline"
                  className="font-mono uppercase"
                  onClick={handleOpenCurrent}
                  disabled={switching}
                  data-testid="share-branch-switch-open-current"
                >
                  <MapPin className="size-3.5" aria-hidden />
                  {openCurrentLabel}
                </Button>
              ) : null}
              <Button
                onClick={handleSwitch}
                disabled={!variant?.switchEnabled || switching}
                aria-disabled={!variant?.switchEnabled || switching}
                aria-describedby={
                  variant && !variant.switchEnabled && variant.conflictingFiles.length > 0
                    ? conflictListId
                    : undefined
                }
                data-testid="share-branch-switch-switch"
              >
                {switching ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    {switchLabel}
                  </>
                ) : (
                  <>
                    <GitBranch className="size-3.5" aria-hidden />
                    {switchLabel}
                  </>
                )}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
