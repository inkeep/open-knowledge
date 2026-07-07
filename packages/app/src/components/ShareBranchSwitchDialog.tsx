/**
 * Project-scoped branch-switch dialog. Mounts in the editor shell and
 * renders only on `project-branch-switch` payloads — the editor window
 * owns this project, but its current checkout differs from the share's
 * branch. Main has already resolved the target, so the renderer consumes
 * `payload.projectPath` + `payload.share` directly and drives the
 * state machine in `@/lib/share/branch-switch-flow`.
 *
 * STOP rule: the Switch path MUST NOT navigate on `runCheckout` HTTP 200
 * alone — dismissal waits for the CC1 `branch-switched` broadcast via
 * `bridge.project.awaitBranchSwitched`.
 *
 * Cancel discipline: this window IS the editor; Cancel only dismisses the
 * store (no window close), so the user remains in the project on its
 * current branch.
 */

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
  applyVerdict,
  type BranchSwitchDialogState,
  type CheckoutSideEffectReason,
  formatCurrentLabel,
  initialBranchSwitchState,
  markSwitching,
  markVerdictPending,
  selectBranchSwitchVariant,
  shouldProbeTargetStatus,
} from '@/lib/share/branch-switch-flow';
import { missDialogStore } from '@/lib/share/miss-dialog-store';
import { formatReceiveLog } from '@/lib/share/receive-flow';
import { type ShareReceiveStore, shareReceiveStore } from '@/lib/share/receive-store';

export interface ShareBranchSwitchDialogProps {
  bridge: OkDesktopBridge;
  /** Override store for testability. Production uses the singleton. */
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
  const verdictProbeStartedRef = useRef(false);
  // The payload the verdict probe currently belongs to. The verdict-probe effect
  // self-transitions its own phase dep, so a cleanup-based cancel would drop its
  // own result; it compares against this instead to ignore a late verdict from a
  // superseded share. Updated in the per-payload reset effect below.
  const verdictPayloadRef = useRef<ProjectBranchSwitchPayload | null>(null);

  const active = isBranchSwitchPayload(payload) ? payload : null;
  // Kind-aware noun so every surface (title, body, toasts) reads correctly for
  // both single-doc and folder shares. `share.target.kind` is the discriminant;
  // defaults to "document" when there's no active payload (no surface renders then).
  const targetNoun = active?.share.target.kind === 'folder' ? t`folder` : t`document`;

  // Per-payload reset so a second share doesn't inherit the prior payload's
  // single-fire refs / state. The component stays mounted at the App root.
  // Unlike ShareReceiveDialog (which uses a keyed remount to dodge a
  // consent-seed-vs-reset race between two effects), this dialog resets in a
  // single effect with no competing seed effect, and the store nulls `payload`
  // via dismiss() between shares — so the imperative reset is race-free here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: payload is the reset trigger; the body resets state and captures the payload for the verdict staleness check.
  useEffect(() => {
    setBranchSwitchState(initialBranchSwitchState);
    branchInfoStartedRef.current = false;
    awaitBranchSwitchedStartedRef.current = false;
    verdictProbeStartedRef.current = false;
    verdictPayloadRef.current = active;
  }, [payload]);

  // Fetch branch-info once per payload so the variant matrix has fresh
  // dirty-conflicts + shareTargetExists data. Single-fire via ref so render
  // churn (state changes that re-trigger the effect) can't double-fetch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref-guarded single-fire; unstable bridge identity would re-trigger.
  useEffect(() => {
    if (!active) return;
    if (branchInfoStartedRef.current) return;
    branchInfoStartedRef.current = true;
    // Guard against a stale write: the dialog stays mounted across payloads, so
    // a payload-A fetch that resolves after payload B armed must not stomp B's
    // freshly-reset state (mirrors the awaiting-cc1 effect below).
    let cancelled = false;
    void bridge.project
      .fetchBranchInfo({
        projectPath: active.projectPath,
        branch: active.share.branch,
        kind: active.share.target.kind,
        path: shareTargetPath(active.share.target),
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

  // Origin-hint pivot: when branch-info reports the target isn't on origin's
  // branch (a stale-local-ref hint), fetch a real verdict rather than
  // over-promising that a plain switch recovers it. Single-fire per payload so
  // an `unknown` fallback to `ready` can't re-arm the probe into a loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: phase-gated single-fire; bridge identity churns every parent render.
  useEffect(() => {
    if (!active) return;
    if (branchSwitchState.phase !== 'ready') return;
    if (verdictProbeStartedRef.current) return;
    if (!shouldProbeTargetStatus(branchSwitchState.info)) return;
    verdictProbeStartedRef.current = true;
    setBranchSwitchState(markVerdictPending);
    // Stale-write guard keyed on payload identity, not a cleanup cancel: this
    // effect self-transitions its own phase dep (markVerdictPending), so a
    // cleanup would fire on that transition and drop this very verdict. Compare
    // the payload this fetch was issued for against the latest one instead, so a
    // late verdict from a superseded share is ignored.
    const fetchedFor = active;
    void bridge.project
      .fetchTargetStatus({
        projectPath: active.projectPath,
        branch: active.share.branch,
        kind: active.share.target.kind,
        path: shareTargetPath(active.share.target),
      })
      .then((status) => {
        if (verdictPayloadRef.current !== fetchedFor) return;
        setBranchSwitchState((prev) => applyVerdict(prev, status));
      })
      .catch((err) => {
        if (verdictPayloadRef.current !== fetchedFor) return;
        // Fail-open: a rejected probe degrades to today's plain switch (the
        // post-switch guard backstops the residual miss), never a stuck dialog.
        console.warn(
          '[receive] target-status-fetch-failed',
          err instanceof Error ? err.message : err,
        );
        setBranchSwitchState((prev) => applyVerdict(prev, null));
      });
  }, [branchSwitchState.phase, active]);

  // Terminal-miss handoff: `deleted` / `never-on-branch` mean the shared target
  // is gone on the share branch, so there is nothing to switch to — the
  // "Open shared document" branch-switch shell is the wrong surface. Hand off to
  // the dedicated miss dialog (honest verdict + Browse-folder escape), which the
  // branch-match-ok deep-link path already uses, so a removed target reads
  // identically regardless of which dispatch path delivered the share.
  useEffect(() => {
    if (branchSwitchState.phase !== 'verdict') return;
    const { kind } = branchSwitchState.resolution;
    if (kind !== 'deleted' && kind !== 'never-on-branch') return;
    if (!active) return;
    missDialogStore.arm({
      kind: active.share.target.kind,
      path: shareTargetPath(active.share.target),
      branch: active.share.branch,
    });
    store.dismiss();
  }, [branchSwitchState, active, store]);

  // CC1-driven post-checkout navigation gate. After Switch resolves
  // `{ok:true}` the state transitions to `awaiting-cc1-recycle`; we poll
  // server-info (the late-join backstop for the CC1 `branch-switched`
  // broadcast) and dispatch the warm-focus deep-link only after the recycle
  // settles. Mirrors the proven pattern in the legacy ShareReceiveDialog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: phase-keyed single-fire; bridge identity churns every parent render.
  useEffect(() => {
    if (branchSwitchState.phase !== 'awaiting-cc1-recycle') return;
    if (!active) return;
    const shareBranch = active.share.branch;
    // The navigation target the switch committed to — the original share path
    // for a plain / on-origin switch, or `renamedTo` when a rename was accepted.
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
              pendingDeepLinkTarget: {
                kind: active.share.target.kind,
                path: pendingNavPath,
              },
              pendingBranch: shareBranch,
            })
            .catch((err) => {
              console.warn(
                '[receive] warm-focus-dispatch-failed branch_action=switch',
                err instanceof Error ? err.message : err,
              );
              // The dialog dismisses synchronously below before this open
              // settles, so a reject here would otherwise leave the user in
              // the editor with no doc open and no explanation. Surface it —
              // matching the timeout/reject paths above.
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
        // A reject here is an unexpected IPC failure, not the CC1 timeout
        // handled above — log the identity and use a distinct message so the
        // two are not conflated in diagnostics or the user's view.
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

  // Shared switch executor. `fastForward` rides only for the on-origin /
  // renamed verdict cells (the server updates the stale local ref before
  // checkout so the doc lands); the plain switch and the diverged cell pass it
  // off. `pendingDoc` is the post-switch navigation target — the original path,
  // or `renamedTo` when a rename was accepted.
  function runSwitch(pendingDoc: string, fastForward: boolean): void {
    console.log(
      formatReceiveLog({
        branch_dialog_action: 'switch',
        branch_action: 'switch',
        branch: shareBranch,
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
        // Log the rejection identity (IPC timeout, channel closed) — the toast
        // alone gives no triage signal — consistent with every other catch in
        // this component.
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

  // Verdict-cell actions. on-origin / renamed fast-forward the stale local ref
  // to origin's tip before switching so the doc actually lands; diverged offers
  // a plain switch (no fast-forward — the receive flow never merges).
  function handleSwitchAndUpdate(): void {
    if (branchSwitchState.phase !== 'verdict') return;
    runSwitch(shareTargetPath(share.target), true);
  }

  function handleOpenRenamed(): void {
    if (branchSwitchState.phase !== 'verdict') return;
    if (branchSwitchState.resolution.kind !== 'renamed') return;
    runSwitch(branchSwitchState.resolution.renamedTo, true);
  }

  function handlePlainSwitchFromVerdict(): void {
    if (branchSwitchState.phase !== 'verdict') return;
    runSwitch(shareTargetPath(share.target), false);
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
        // `store.dismiss()` runs synchronously below before this open settles;
        // without a toast a reject leaves the user in the editor with no doc
        // and no feedback. Surface it like the switch path does.
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

  // Cancel: this window IS the editor; closing it would close the user's
  // session. store.dismiss() leaves the editor open on its current branch.
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
          ) : branchSwitchState.phase === 'verdict-pending' ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="share-branch-switch-verdict-pending"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
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
              // deleted / never-on-branch: the target is gone on the share
              // branch. The handoff effect arms the dedicated miss dialog and
              // dismisses this one, so render a brief spinner rather than the
              // terminal verdict cell — the miss dialog owns that copy + the
              // Browse-folder escape now.
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                data-testid="share-branch-switch-verdict-handoff"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
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
