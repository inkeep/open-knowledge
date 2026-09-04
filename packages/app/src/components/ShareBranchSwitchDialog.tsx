// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type { WorktreeCreateResult } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { AppWindow, GitBranch, MapPin } from 'lucide-react';
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
import { Spinner } from '@/components/ui/spinner';
import { authPromptStore } from '@/lib/auth-prompt-store';
import {
  type OkDesktopBridge,
  type OkShareReceivedPayload,
  shareTargetPath,
} from '@/lib/desktop-bridge-types';
import {
  applyBranchInfo,
  applyCheckoutOutcome,
  applyVerdict,
  applyWorktreeCheckoutOutcome,
  type BranchSwitchDialogState,
  type CheckoutSideEffectReason,
  formatCurrentLabel,
  initialBranchSwitchState,
  markCreatingWorktree,
  markSwitching,
  markVerdictPending,
  selectBranchSwitchVariant,
  shouldProbeTargetStatus,
  type VerdictCellKind,
  type WorktreeCheckoutSideEffectReason,
} from '@/lib/share/branch-switch-flow';
import { missDialogStore } from '@/lib/share/miss-dialog-store';
import { formatReceiveLog } from '@/lib/share/receive-flow';
import { type ShareReceiveStore, shareReceiveStore } from '@/lib/share/receive-store';
import { refreshWorktrees } from '@/lib/worktree-store';

export interface ShareBranchSwitchDialogProps {
  bridge: OkDesktopBridge;
  store?: ShareReceiveStore;
}

type ProjectBranchSwitchPayload = Extract<
  OkShareReceivedPayload,
  { kind: 'project-branch-switch' }
>;

function shareRepositoryPath(share: ProjectBranchSwitchPayload['share']): string {
  return shareTargetPath(share.repositoryTarget);
}

function pendingTarget(
  share: ProjectBranchSwitchPayload['share'],
  path = shareTargetPath(share.target),
) {
  const repositoryPath =
    share.contentRootDepth === null
      ? path
      : [
          ...shareRepositoryPath(share).split('/').slice(0, share.contentRootDepth),
          ...(path === '' ? [] : path.split('/')),
        ].join('/');
  return {
    kind: share.target.kind,
    path,
    repositoryPath,
    ...(share.contentRootDepth === null ? {} : { contentRootDepth: share.contentRootDepth }),
  };
}

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
  const verdictProbeStartedRef = useRef(false);
  const verdictPayloadRef = useRef<ProjectBranchSwitchPayload | null>(null);

  const active = isBranchSwitchPayload(payload) ? payload : null;
  const targetNoun = active?.share.target.kind === 'folder' ? t`folder` : t`document`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: payload is the reset trigger; the body resets state and captures the payload for the verdict staleness check.
  useEffect(() => {
    setBranchSwitchState(initialBranchSwitchState);
    branchInfoStartedRef.current = false;
    awaitBranchSwitchedStartedRef.current = false;
    verdictProbeStartedRef.current = false;
    verdictPayloadRef.current = active;
  }, [payload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref-guarded single-fire; unstable bridge identity would re-trigger.
  useEffect(() => {
    if (!active) return;
    if (branchInfoStartedRef.current) return;
    branchInfoStartedRef.current = true;
    let cancelled = false;
    void bridge.project
      .fetchBranchInfo({
        projectPath: active.projectPath,
        branch: active.share.branch,
        kind: active.share.repositoryTarget.kind,
        path: shareRepositoryPath(active.share),
      })
      .then((info) => {
        if (cancelled) return;
        setBranchSwitchState((prev) => applyBranchInfo(prev, info));
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(
          '[receive] branch-info-fetch-failed',
          err instanceof Error ? err.message : err,
        );
        setBranchSwitchState((prev) => applyBranchInfo(prev, null));
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: phase-gated single-fire; bridge identity churns every parent render.
  useEffect(() => {
    if (!active) return;
    if (branchSwitchState.phase !== 'ready') return;
    if (verdictProbeStartedRef.current) return;
    if (!shouldProbeTargetStatus(branchSwitchState.info)) return;
    verdictProbeStartedRef.current = true;
    setBranchSwitchState(markVerdictPending);
    const fetchedFor = active;
    void bridge.project
      .fetchTargetStatus({
        projectPath: active.projectPath,
        branch: active.share.branch,
        kind: active.share.target.kind,
        path: shareRepositoryPath(active.share),
        ...(active.share.contentRootDepth === null
          ? {}
          : { contentRootDepth: active.share.contentRootDepth }),
      })
      .then((status) => {
        if (verdictPayloadRef.current !== fetchedFor) return;
        setBranchSwitchState((prev) => applyVerdict(prev, status));
      })
      .catch((err) => {
        if (verdictPayloadRef.current !== fetchedFor) return;
        console.warn(
          '[receive] target-status-fetch-failed',
          err instanceof Error ? err.message : err,
        );
        setBranchSwitchState((prev) => applyVerdict(prev, null));
      });
  }, [branchSwitchState.phase, active]);

  useEffect(() => {
    if (branchSwitchState.phase !== 'verdict') return;
    const { kind } = branchSwitchState.resolution;
    if (kind !== 'deleted' && kind !== 'never-on-branch') return;
    if (!active) return;
    missDialogStore.arm({
      kind: active.share.target.kind,
      path: shareTargetPath(active.share.target),
      repositoryPath: shareRepositoryPath(active.share),
      ...(active.share.contentRootDepth === null
        ? {}
        : { contentRootDepth: active.share.contentRootDepth }),
      branch: active.share.branch,
    });
    store.dismiss();
  }, [branchSwitchState, active, store]);

  useEffect(() => {
    if (branchSwitchState.phase !== 'verdict') return;
    console.log(formatReceiveLog({ verdict_cell: branchSwitchState.resolution.kind }));
  }, [branchSwitchState]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: phase-keyed single-fire; bridge identity churns every parent render.
  useEffect(() => {
    if (branchSwitchState.phase !== 'awaiting-cc1-recycle') return;
    if (!active) return;
    const shareBranch = active.share.branch;
    const pendingNavPath = branchSwitchState.pendingDoc;
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
              pendingDeepLinkTarget: pendingTarget(active.share, pendingNavPath),
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

  function runSwitch(
    pendingDoc: string,
    fastForward: boolean,
    verdictCell?: VerdictCellKind,
  ): void {
    console.log(
      formatReceiveLog({
        branch_dialog_action: 'switch',
        branch_action: 'switch',
        branch: shareBranch,
        verdict_cell: verdictCell,
      }),
    );
    setBranchSwitchState((prev) => markSwitching(prev, pendingDoc));
    void bridge.project
      .runCheckout(
        fastForward
          ? { projectPath, branch: shareBranch, fastForward: true }
          : { projectPath, branch: shareBranch },
      )
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

  function handleSwitch(): void {
    if (branchSwitchState.phase !== 'ready') return;
    const variant = selectBranchSwitchVariant(branchSwitchState.info);
    if (!variant.switchEnabled) return;
    runSwitch(shareTargetPath(share.target), false);
  }

  function handleSwitchAndUpdate(): void {
    if (branchSwitchState.phase !== 'verdict') return;
    runSwitch(shareTargetPath(share.target), true, branchSwitchState.resolution.kind);
  }

  function handleOpenRenamed(): void {
    if (branchSwitchState.phase !== 'verdict') return;
    if (branchSwitchState.resolution.kind !== 'renamed') return;
    runSwitch(branchSwitchState.resolution.renamedTo, true, branchSwitchState.resolution.kind);
  }

  function handlePlainSwitchFromVerdict(): void {
    if (branchSwitchState.phase !== 'verdict') return;
    runSwitch(shareTargetPath(share.target), false, branchSwitchState.resolution.kind);
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
        pendingDeepLinkTarget: pendingTarget(share),
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

  function showWorktreeFailureToast(
    reason: WorktreeCheckoutSideEffectReason,
    {
      helper,
      authFailed,
      notFoundAsIdentity,
    }: { helper?: string; authFailed?: true; notFoundAsIdentity?: true } = {},
  ): void {
    if (reason === 'fetch-failed' && notFoundAsIdentity) {
      toast.error(
        t`Repository not found — it may not exist, or the account used may not have access.`,
      );
      return;
    }
    if (reason === 'fetch-failed' && authFailed) {
      toast.error(t`Could not fetch branch — sign in to GitHub and try again.`, {
        action: {
          label: t`Sign in`,
          onClick: () => authPromptStore.request(),
        },
      });
      return;
    }
    switch (reason) {
      case 'helper-not-found': {
        const tool = helper ?? t`a required git tool`;
        toast.error(
          t`Git needs ${tool} for this repository, but it isn't installed or couldn't be found. Install it, then try again.`,
        );
        return;
      }
      case 'branch-not-found':
        toast.error(t`Branch ${shareBranch} no longer exists on the remote.`);
        return;
      case 'fetch-failed':
        toast.error(t`Could not fetch branch. Check your connection.`);
        return;
      case 'already-checked-out':
        toast.error(t`That branch is already open in another worktree.`);
        return;
      case 'branch-exists':
        toast.error(
          t`A branch named ${shareBranch} already exists. Open its worktree from the switcher instead.`,
        );
        return;
      case 'path-exists':
        toast.error(t`A worktree folder for ${shareBranch} already exists.`);
        return;
      case 'no-git':
        toast.error(t`This project isn't a git repository, so worktrees aren't available.`);
        return;
      case 'empty-repo':
        toast.error(
          t`This project has no commits yet, so there's no branch to base a worktree on. Make a first commit, then try again.`,
        );
        return;
      case 'invalid-branch':
        toast.error(t`${shareBranch} isn't a valid branch name.`);
        return;
      case 'proxy-null':
      case 'error':
        toast.error(t`Could not open ${shareBranch} in a worktree. Try again.`);
        return;
      default: {
        const _exhaustive: never = reason;
        throw new Error(`Unhandled worktree failure reason: ${String(_exhaustive)}`);
      }
    }
  }

  function applyWorktreeOutcome(result: WorktreeCreateResult | null): void {
    let failureReason: WorktreeCheckoutSideEffectReason | null = null;
    let failureHelper: string | undefined;
    let failureAuth: true | undefined;
    let failureNotFoundAsIdentity: true | undefined;
    let shouldDismiss = false;
    let openPath: string | null = null;
    setBranchSwitchState((prev) => {
      const { state: next, sideEffect } = applyWorktreeCheckoutOutcome(prev, result);
      if (sideEffect) {
        failureReason = sideEffect.reason;
        failureHelper = sideEffect.helper;
        failureAuth = sideEffect.authFailed;
        failureNotFoundAsIdentity = sideEffect.notFoundAsIdentity;
        shouldDismiss = next.phase === 'dismissed';
      }
      if (next.phase === 'opening-worktree') {
        openPath = next.path;
      }
      return next;
    });
    if (failureReason !== null) {
      console.log(
        formatReceiveLog({
          branch_dialog_action: `open-worktree-failed:${failureReason}`,
          branch: shareBranch,
        }),
      );
      showWorktreeFailureToast(failureReason, {
        helper: failureHelper,
        authFailed: failureAuth,
        notFoundAsIdentity: failureNotFoundAsIdentity,
      });
    }
    if (openPath !== null) {
      refreshWorktrees();
      const target = openPath;
      void bridge.project
        .open({
          path: target,
          target: 'new-window',
          entryPoint: 'worktree',
          pendingDeepLinkTarget: pendingTarget(share),
          pendingBranch: shareBranch,
        })
        .catch((err) => {
          console.warn(
            '[receive] worktree-open-failed branch_dialog_action=open-worktree',
            err instanceof Error ? err.message : err,
          );
          toast.error(t`Could not open ${target}. Try opening it manually.`);
        });
      store.dismiss();
    }
    if (shouldDismiss) store.dismiss();
  }

  function handleOpenWorktree(): void {
    if (branchSwitchState.phase !== 'ready') return;
    console.log(
      formatReceiveLog({
        branch_dialog_action: 'open-worktree',
        branch: shareBranch,
      }),
    );
    setBranchSwitchState(markCreatingWorktree);
    void bridge.worktree
      .checkout({ branch: shareBranch })
      .then((result) => {
        applyWorktreeOutcome(result);
      })
      .catch((err) => {
        console.warn(
          '[receive] worktree-checkout rejected branch_dialog_action=open-worktree',
          err instanceof Error ? err.message : err,
        );
        applyWorktreeOutcome(null);
      });
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
        pendingDeepLinkTarget: pendingTarget(share),
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
    console.log(
      formatReceiveLog({
        branch_dialog_action: 'cancel',
        verdict_cell:
          branchSwitchState.phase === 'verdict' ? branchSwitchState.resolution.kind : undefined,
      }),
    );
    store.dismiss();
  }

  const variant =
    branchSwitchState.phase === 'ready' ||
    branchSwitchState.phase === 'switching' ||
    branchSwitchState.phase === 'creating-worktree'
      ? selectBranchSwitchVariant(branchSwitchState.info)
      : null;
  const currentLabel =
    branchSwitchState.phase === 'ready' ||
    branchSwitchState.phase === 'switching' ||
    branchSwitchState.phase === 'creating-worktree'
      ? formatCurrentLabel(branchSwitchState.info)
      : (payloadCurrentBranch ?? 'HEAD');
  const switching =
    branchSwitchState.phase === 'switching' || branchSwitchState.phase === 'awaiting-cc1-recycle';
  const creating = branchSwitchState.phase === 'creating-worktree';
  const openCurrentLabel = t`Open in current branch`;
  const switchLabel = t`Switch branch`;
  const worktreeLabel = t`Open in worktree`;
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
          ) : branchSwitchState.phase === 'verdict-pending' ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="share-branch-switch-verdict-pending"
              role="status"
              aria-live="polite"
            >
              <Spinner className="h-4 w-4" aria-hidden="true" />
              <Trans>Checking for updates on GitHub</Trans>
            </p>
          ) : branchSwitchState.phase === 'verdict' ? (
            branchSwitchState.resolution.kind === 'on-origin' ? (
              <p
                className="text-sm leading-6 text-muted-foreground"
                data-testid="share-branch-switch-verdict-on-origin"
              >
                <Trans>
                  This {targetNoun} was added to branch{' '}
                  <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                    {shareBranch}
                  </code>{' '}
                  recently. Switch and update to open it.
                </Trans>
              </p>
            ) : branchSwitchState.resolution.kind === 'renamed' ? (
              <p
                className="text-sm leading-6 text-muted-foreground"
                data-testid="share-branch-switch-verdict-renamed"
              >
                <Trans>
                  This {targetNoun} moved to{' '}
                  <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                    {branchSwitchState.resolution.renamedTo}
                  </code>
                  . Open it there?
                </Trans>
              </p>
            ) : branchSwitchState.resolution.kind === 'diverged' ? (
              <p
                className="text-sm leading-6 text-muted-foreground"
                data-testid="share-branch-switch-verdict-diverged"
              >
                <Trans>
                  Your copy of branch{' '}
                  <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                    {shareBranch}
                  </code>{' '}
                  has changes that aren't on GitHub. The {targetNoun} will appear once the branch
                  syncs.
                </Trans>
              </p>
            ) : (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                data-testid="share-branch-switch-verdict-handoff"
                role="status"
                aria-live="polite"
              >
                <Spinner className="h-4 w-4" aria-hidden="true" />
                <Trans>Checking for updates on GitHub</Trans>
              </p>
            )
          ) : isLoading ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="share-branch-switch-loading"
              role="status"
              aria-live="polite"
            >
              <Spinner className="h-4 w-4" aria-hidden="true" />
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
                . You have uncommitted changes that prevent switching here — open it in a worktree
                to leave your changes untouched.
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
              <Spinner className="h-4 w-4" aria-hidden="true" />
              <Trans>Switching branches</Trans>
            </p>
          ) : null}
          {creating ? (
            <p
              className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="share-branch-switch-creating-worktree"
              role="status"
              aria-live="polite"
            >
              <Spinner className="h-4 w-4" aria-hidden="true" />
              <Trans>Opening worktree</Trans>
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={handleCancel} data-testid="share-branch-switch-cancel">
            <Trans>Cancel</Trans>
          </Button>
          {branchSwitchState.phase === 'branch-in-other-worktree' ? (
            <Button onClick={handlePivot} data-testid="share-branch-switch-in-other-worktree-pivot">
              <Trans>Open that worktree instead</Trans>
            </Button>
          ) : branchSwitchState.phase === 'verdict' ? (
            branchSwitchState.resolution.kind === 'on-origin' ? (
              <Button
                onClick={handleSwitchAndUpdate}
                data-testid="share-branch-switch-verdict-switch-update"
              >
                <GitBranch className="size-3.5" aria-hidden />
                <Trans>Switch and update branch</Trans>
              </Button>
            ) : branchSwitchState.resolution.kind === 'renamed' ? (
              <Button
                onClick={handleOpenRenamed}
                data-testid="share-branch-switch-verdict-open-renamed"
              >
                <MapPin className="size-3.5" aria-hidden />
                <Trans>Open it there</Trans>
              </Button>
            ) : branchSwitchState.resolution.kind === 'diverged' ? (
              <Button
                onClick={handlePlainSwitchFromVerdict}
                data-testid="share-branch-switch-verdict-plain-switch"
              >
                <GitBranch className="size-3.5" aria-hidden />
                {switchLabel}
              </Button>
            ) : null
          ) : (
            <div className="flex min-w-0 flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end sm:gap-2">
              {variant?.openCurrentEnabled ? (
                <Button
                  variant="outline"
                  onClick={handleOpenCurrent}
                  disabled={switching || creating}
                  data-testid="share-branch-switch-open-current"
                >
                  <MapPin className="size-3.5" aria-hidden />
                  {openCurrentLabel}
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={handleSwitch}
                disabled={!variant?.switchEnabled || switching || creating}
                aria-disabled={!variant?.switchEnabled || switching || creating}
                aria-describedby={
                  variant && !variant.switchEnabled && variant.conflictingFiles.length > 0
                    ? conflictListId
                    : undefined
                }
                data-testid="share-branch-switch-switch"
              >
                {switching ? (
                  <>
                    <Spinner className="size-3.5" aria-hidden="true" />
                    {switchLabel}
                  </>
                ) : (
                  <>
                    <GitBranch className="size-3.5" aria-hidden />
                    {switchLabel}
                  </>
                )}
              </Button>
              <Button
                onClick={handleOpenWorktree}
                disabled={!variant || switching || creating}
                data-testid="share-branch-switch-worktree"
              >
                {creating ? (
                  <>
                    <Spinner className="size-3.5" aria-hidden="true" />
                    {worktreeLabel}
                  </>
                ) : (
                  <>
                    <AppWindow className="size-3.5" aria-hidden />
                    {worktreeLabel}
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
