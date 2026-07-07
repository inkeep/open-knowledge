// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — Q2 card grid uses raw <button> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * Launcher-scoped share receive dialog. Mounted only in NavigatorApp and
 * gated on the main-resolved share payloads `'launcher-consent'` (a
 * worktree on the share branch that lacks `.ok/config.yml`) and
 * `'launcher-miss'` (no usable local copy — clone or locate-locally).
 *
 * Main has already resolved the share target, so this dialog does NOT
 * re-run candidate selection. The renderer lookup, branch-switch
 * surface, and doc-missing surface that lived here historically moved
 * to main-side routing (lookup + selection) and to ShareBranchSwitchDialog
 * (branch-switch, project-scoped).
 *
 * Surfaces remaining here:
 *   - `'launcher-consent'`: one-shot consent dialog driven by
 *     `consent-flow.ts`. `Initialize and open` runs the scaffold via
 *     `bridge.project.okInit`, then dispatches `bridge.project.open` with
 *     `pendingDeepLinkTarget + pendingBranch`.
 *   - `'launcher-miss'`: cards — Clone from GitHub (with auth
 *     pre-flight via the cloneController) vs `I already have it locally`
 *     (folder picker + `bridge.share.validateLocalFolder`).
 */

import { classifyBranchMatch } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
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
  type HeadBranchInfo,
  type OkDesktopBridge,
  type OkLocalOpAuthStatusResponse,
  type OkShareReceivedPayload,
  shareTargetPath,
} from '@/lib/desktop-bridge-types';
import {
  applyOkInitOutcome,
  applyOpenOutcome,
  type ConsentFlowState,
  initialConsentFlowState,
  markCancelled as markConsentCancelled,
  markInitializing,
} from '@/lib/share/consent-flow';
import {
  buildCloneUrl,
  canonicalGitHubRemoteUrl,
  formatCloneErrorMessage,
  formatReceiveLog,
  mapValidationToToast,
  presentReceiveError,
} from '@/lib/share/receive-flow';
import { type ShareReceiveStore, shareReceiveStore } from '@/lib/share/receive-store';

/**
 * Result of a streamlined clone run. `kind` discriminates the three terminal
 * states the dialog cares about: success (open the new project), user-
 * cancellation (silent — no toast), and recoverable failure (the controller
 * has already surfaced a toast; the dialog stays mounted so the user can
 * retry or pick local instead).
 */
export type ShareReceiveCloneResult =
  | { readonly kind: 'ok'; readonly dir: string }
  | { readonly kind: 'cancelled' }
  // `detail` carries the raw (redacted) git message for the dialog's
  // technical-details disclosure; absent when the failure had no git output.
  | { readonly kind: 'error'; readonly detail?: string };

export interface ShareReceiveCloneController {
  getAuthStatus(): Promise<OkLocalOpAuthStatusResponse>;
  startSignIn(): Promise<OkLocalOpAuthStatusResponse | null>;
  runClone(args: { url: string; branch?: string | null }): Promise<ShareReceiveCloneResult>;
}

export interface ShareReceiveDialogProps {
  bridge: OkDesktopBridge;
  /** Parent-provided controller for the auth + clone flow. */
  cloneController?: ShareReceiveCloneController;
  /** Override store for testability. Production uses the singleton. */
  store?: ShareReceiveStore;
}

type LauncherConsentPayload = Extract<OkShareReceivedPayload, { kind: 'launcher-consent' }>;
type LauncherMissPayload = Extract<OkShareReceivedPayload, { kind: 'launcher-miss' }>;

function isLauncherConsentPayload(
  payload: OkShareReceivedPayload | null,
): payload is LauncherConsentPayload {
  return payload !== null && payload.kind === 'launcher-consent';
}

function isLauncherMissPayload(
  payload: OkShareReceivedPayload | null,
): payload is LauncherMissPayload {
  return payload !== null && payload.kind === 'launcher-miss';
}

/**
 * Store-subscribing outer shell. It owns the non-launcher dismissal toast
 * and remounts the inner dialog per payload via `key`, so each new share
 * gets fresh `useState` / `useRef` instead of imperatively resetting
 * sibling state from props (the consent-seed-vs-reset race the keyed
 * remount eliminates).
 */
export function ShareReceiveDialog({
  bridge,
  cloneController,
  store = shareReceiveStore,
}: ShareReceiveDialogProps) {
  const payload = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);

  // Remount key derived from payload object identity via a render-phase state
  // update — the React-sanctioned "reset all state when a prop changes" pattern
  // (refs can't be read or written during render under React Compiler). The
  // store hands out a fresh object on every emission, so identical re-shares
  // still bump the key and remount; a content-derived key would collide.
  const [remountKey, setRemountKey] = useState(0);
  const [seenPayload, setSeenPayload] = useState<OkShareReceivedPayload | null>(payload);
  if (payload !== seenPayload) {
    setSeenPayload(payload);
    setRemountKey((k) => k + 1);
  }

  // Drive non-launcher payloads (unsupported-version / invalid) to a toast
  // and dismiss the store so the dialog never visually mounts for them.
  useEffect(() => {
    if (!payload) return;
    const error = presentReceiveError(payload);
    if (error) {
      toast.error(error.message);
      store.dismiss();
    }
  }, [payload, store]);

  const launcherMiss = isLauncherMissPayload(payload) ? payload : null;
  const launcherConsent = isLauncherConsentPayload(payload) ? payload : null;
  const active = launcherConsent ?? launcherMiss;
  if (!active) return null;

  return (
    <ShareReceiveDialogInner
      key={remountKey}
      payload={active}
      bridge={bridge}
      cloneController={cloneController}
      store={store}
    />
  );
}

interface ShareReceiveDialogInnerProps {
  payload: LauncherConsentPayload | LauncherMissPayload;
  bridge: OkDesktopBridge;
  cloneController?: ShareReceiveCloneController;
  store: ShareReceiveStore;
}

/**
 * Per-payload dialog body. Remounted by the outer shell on each new share,
 * so its `useState` / `useRef` start fresh — no manual reset effect, and the
 * consent seed runs exactly once against a guaranteed-null initial state.
 */
function ShareReceiveDialogInner({
  payload,
  bridge,
  cloneController,
  store,
}: ShareReceiveDialogInnerProps) {
  const { t } = useLingui();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<OkLocalOpAuthStatusResponse | null>(null);
  const [authChecking, setAuthChecking] = useState(false);
  const [cloneRunning, setCloneRunning] = useState(false);
  // Persistent in-dialog presentation of a clone failure (the GitHub error +
  // likely causes), replacing the transient toast so the user can read the
  // reasons and recover. `detail` is the raw git output (condensed for display);
  // null when the failure carried no git message.
  const [cloneError, setCloneError] = useState<{ detail: string | null } | null>(null);
  const [consentState, setConsentState] = useState<ConsentFlowState | null>(null);
  // Single-fire guard for the auth pre-flight probe. State-only guards
  // race with the effect's own re-trigger (setAuthChecking(true) re-runs
  // the effect, the cleanup flags cancelled=true, then the in-flight
  // promise short-circuits and the banner stays on "Checking..." forever).
  const authProbeStartedRef = useRef(false);
  // Move focus to the error card when a clone fails so the recovery actions are
  // a single Tab away — the Clone button the user clicked unmounts when the card
  // grid swaps to the error view, leaving keyboard focus undefined otherwise.
  const cloneErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cloneError) cloneErrorRef.current?.focus();
  }, [cloneError]);

  // Seed the consent flow when main routes a launcher-consent payload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: payload-keyed effect; setConsentState identity is stable.
  useEffect(() => {
    if (!isLauncherConsentPayload(payload)) return;
    if (consentState !== null) return;
    console.warn(
      `[receive] q1_hit=true selection=branch_match_non_ok candidate=${payload.candidatePath}`,
    );
    setConsentState(
      initialConsentFlowState({
        candidatePath: payload.candidatePath,
        branch: payload.share.branch,
        targetPath: shareTargetPath(payload.share.target),
        targetKind: payload.share.target.kind,
        parentProjectName: payload.parentProjectName,
      }),
    );
  }, [payload]);

  // Pre-flight auth check for the launcher-miss (cards) path: when the
  // payload first lands, fetch the controller's current auth status so the
  // Clone CTA can render correctly up-front (sign-in link + disabled Clone
  // if unauthed) rather than letting the user click into a failure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cloneController identity churns every render; we want this gated on payload + auth-state transitions only.
  useEffect(() => {
    if (!cloneController) return;
    if (!isLauncherMissPayload(payload)) return;
    if (authStatus !== null) return;
    if (authProbeStartedRef.current) return;
    authProbeStartedRef.current = true;
    setAuthChecking(true);
    void cloneController
      .getAuthStatus()
      .then((result) => {
        setAuthStatus(result);
      })
      .catch((err) => {
        // Probe failures are non-fatal — render the dialog as if unauthed
        // so the Clone CTA stays disabled and the user can try sign-in
        // manually. Logged for parity with the other catches in this file.
        console.warn(
          '[receive] auth pre-flight probe failed',
          err instanceof Error ? err.message : err,
        );
        setAuthStatus({ authenticated: false, host: 'github.com' });
      })
      .finally(() => {
        setAuthChecking(false);
      });
  }, [payload, authStatus]);

  const launcherMiss = isLauncherMissPayload(payload) ? payload : null;
  const launcherConsent = isLauncherConsentPayload(payload) ? payload : null;
  const share = launcherMiss?.share ?? launcherConsent?.share ?? null;
  const expected = share ? { owner: share.owner, repo: share.repo } : null;
  // Kind-aware noun so the dialog title reads correctly for folder shares as
  // well as single-doc shares; defaults to "document" when no share is active.
  const targetNoun = share?.target.kind === 'folder' ? t`folder` : t`document`;

  async function handleCloneCtaClick(): Promise<void> {
    if (!launcherMiss || !expected) return;
    console.log(formatReceiveLog({ q2_path: 'clone' }));
    if (!cloneController) {
      toast.info(t`Clone happens in the Project Navigator. Reclick the share link there.`, {
        action: {
          label: t`Open Navigator`,
          onClick: () => {
            void bridge.navigator.open();
          },
        },
        duration: 8000,
      });
      return;
    }
    // Public repos clone anonymously — no sign-in required. A private repo's
    // anonymous attempt fails with the classified "may be private" error and
    // the always-present "Connect GitHub" affordance is the sign-in fallback.
    if (cloneRunning) return;
    setCloneError(null);
    setCloneRunning(true);
    const cloneUrl = buildCloneUrl(expected);
    let result: ShareReceiveCloneResult;
    try {
      result = await cloneController.runClone({ url: cloneUrl, branch: launcherMiss.share.branch });
    } catch (err) {
      // The controller is designed to never throw (it converts failures to an
      // error result), so a throw here is unexpected — log it and surface a
      // best-effort detail rather than swallowing the cause to null.
      console.warn('[receive] runClone threw unexpectedly', err);
      setCloneRunning(false);
      setCloneError({ detail: err instanceof Error ? err.message : String(err) });
      return;
    }
    setCloneRunning(false);
    if (result.kind === 'error') {
      setCloneError({ detail: result.detail ?? null });
      return;
    }
    if (result.kind === 'ok') {
      try {
        await bridge.project.open({
          path: result.dir,
          target: 'new-window',
          entryPoint: 'share-receive',
          pendingDeepLinkTarget: {
            kind: launcherMiss.share.target.kind,
            path: shareTargetPath(launcherMiss.share.target),
          },
        });
        // Dismiss only on a successful open — mirrors handleLocalCtaClick. If
        // the open fails the clone already succeeded, so keep the dialog mounted
        // (with the toast) instead of vanishing the user's context.
        store.dismiss();
      } catch (err) {
        console.warn(
          '[receive] project open after clone failed',
          err instanceof Error ? err.message : err,
        );
        toast.error(t`Cloned successfully, but could not open the project.`);
      }
      return;
    }
    // 'cancelled' — user closed the folder picker; leave the dialog mounted.
  }

  async function handleSignInClick(): Promise<void> {
    if (!cloneController || authChecking) return;
    setAuthChecking(true);
    try {
      const next = await cloneController.startSignIn();
      setAuthChecking(false);
      // `null` means the user dismissed the auth modal — keep prior status.
      if (next !== null) setAuthStatus(next);
    } catch (err) {
      // A throw (not the null user-cancel) means sign-in genuinely failed —
      // surface it rather than silently snapping back to "Connect GitHub".
      setAuthChecking(false);
      console.warn('[receive] startSignIn failed', err instanceof Error ? err.message : err);
      toast.error(t`Could not open GitHub sign-in. Please try again.`);
    }
  }

  async function handleLocalCtaClick(): Promise<void> {
    if (!launcherMiss || !expected || pickerOpen) return;
    // Leaving the clone-failure path for the local path: clear the error so the
    // user sees the normal picker flow, not the stale clone-failure banner
    // alongside any folder-validation toast. Mirrors handleCloneCtaClick.
    setCloneError(null);
    setPickerOpen(true);
    console.log(formatReceiveLog({ q2_path: 'local' }));
    try {
      while (true) {
        const folderPath = await bridge.dialog.openFolder();
        if (!folderPath) break;
        const result = await bridge.share.validateLocalFolder({
          folderPath,
          owner: expected.owner,
          repo: expected.repo,
        });
        console.log(formatReceiveLog({ folder_validate: result.kind }));
        if (result.kind === 'ok') {
          // Branch-aware open, symmetric with the recents path: reconcile
          // the located clone's checked-out branch against the share's branch
          // with the SAME classifier the recents path uses (classifyBranchMatch),
          // so a no-branch share, an unreadable HEAD (the all-null sentinel), or
          // an already-matching branch silent-dispatch as a plain open, while a
          // differing or detached HEAD routes to the branch-switch surface. The
          // actual reconciliation (dirty-tree, checkout, navigation) then happens
          // in the editor window via ShareBranchSwitchDialog, which re-reads HEAD.
          const shareBranch = launcherMiss.share.branch;
          let head: HeadBranchInfo = { currentBranch: null, headSha: null, detached: false };
          try {
            head = await bridge.project.readHeadBranch(folderPath);
          } catch (err) {
            // readHeadBranch graceful-fails to the all-null sentinel rather than
            // throwing, so a throw here is an IPC-transport failure. Either way
            // the sentinel classifies as a match ('true') and we plain-open on
            // the current branch — never a dead end.
            console.warn(
              '[receive] local-folder readHeadBranch failed',
              err instanceof Error ? err.message : err,
            );
          }
          const needsBranchSwitch = classifyBranchMatch(shareBranch, head) !== 'true';
          // Validation already succeeded — a throw here is a project-open
          // failure, not a validation failure, so it gets its own scope and an
          // accurate message rather than the misleading "couldn't validate".
          try {
            await bridge.project.open({
              path: folderPath,
              target: 'new-window',
              entryPoint: 'share-receive',
              ...(needsBranchSwitch
                ? {
                    pendingShareBranchSwitch: {
                      share: launcherMiss.share,
                      projectPath: folderPath,
                      currentBranch: head.currentBranch,
                    },
                  }
                : {
                    pendingDeepLinkTarget: {
                      kind: launcherMiss.share.target.kind,
                      path: shareTargetPath(launcherMiss.share.target),
                    },
                  }),
            });
            store.dismiss();
          } catch (err) {
            console.warn(
              '[receive] local-folder-open failed',
              err instanceof Error ? err.message : err,
            );
            toast.error(t`Found the repo but could not open the project. Please try again.`);
          }
          break;
        }
        const message = mapValidationToToast(result, expected);
        if (message) toast.error(message);
      }
    } catch (err) {
      console.warn(
        '[receive] local-folder-validate failed',
        err instanceof Error ? err.message : err,
      );
      toast.error(t`Could not validate folder. Please try again.`);
    }
    setPickerOpen(false);
  }

  function handleConsentInitialize(): void {
    if (consentState === null || consentState.phase !== 'ready') return;
    const seed = consentState.seed;
    console.warn(`[receive] consent_dialog action=initialize worktree=${seed.candidatePath}`);
    setConsentState((prev) => (prev === null ? prev : markInitializing(prev)));
    void bridge.project
      .okInit({ projectPath: seed.candidatePath })
      .then(async (outcome) => {
        if (outcome.ok === true) {
          setConsentState((prev) =>
            prev === null
              ? prev
              : applyOkInitOutcome(prev, { ok: true, projectPath: outcome.projectPath }),
          );
          try {
            await bridge.project.open({
              path: outcome.projectPath,
              target: 'new-window',
              entryPoint: 'share-receive',
              pendingDeepLinkTarget: { kind: seed.targetKind, path: seed.targetPath },
              pendingBranch: seed.branch,
            });
            setConsentState((prev) =>
              prev === null ? prev : applyOpenOutcome(prev, { ok: true }),
            );
            store.dismiss();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setConsentState((prev) =>
              prev === null ? prev : applyOpenOutcome(prev, { ok: false, message }),
            );
            toast.error(t`Initialized ${seed.candidatePath} but could not open it.`);
          }
          return;
        }
        const reason: 'not-a-git-worktree' | 'init-failed' = outcome.reason;
        const message = outcome.message || 'Initialization failed.';
        setConsentState((prev) =>
          prev === null ? prev : applyOkInitOutcome(prev, { ok: false, reason, message }),
        );
        toast.error(message);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        setConsentState((prev) =>
          prev === null
            ? prev
            : applyOkInitOutcome(prev, { ok: false, reason: 'network-error', message }),
        );
        toast.error(t`Could not initialize ${seed.candidatePath}.`);
      });
  }

  function handleConsentCancel(): void {
    if (consentState !== null) {
      console.warn(
        `[receive] consent_dialog action=cancel worktree=${consentState.seed.candidatePath}`,
      );
    }
    setConsentState((prev) => (prev === null ? prev : markConsentCancelled(prev)));
    store.dismiss();
  }

  if (
    consentState !== null &&
    consentState.phase !== 'cancelled' &&
    consentState.phase !== 'done' &&
    share !== null
  ) {
    const seed = consentState.seed;
    const initializing = consentState.phase === 'initializing' || consentState.phase === 'opening';
    return (
      <DialogRoot
        open={true}
        onOpenChange={(open) => {
          if (!open) handleConsentCancel();
        }}
      >
        <DialogContent
          className="sm:max-w-xl"
          data-testid="share-receive-consent-dialog"
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Open shared {targetNoun}</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>
                {share.owner}/{share.repo}{' '}
                {shareTargetPath(share.target) ? `— ${shareTargetPath(share.target)}` : ''}
              </Trans>
            </DialogDescription>
            <ShareMetadataRows
              owner={share.owner}
              repo={share.repo}
              path={shareTargetPath(share.target)}
              kind={share.target.kind}
              branch={share.branch}
              testId="share-receive-metadata"
              branchTestId="share-receive-metadata-branch"
            />
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              <Trans>This branch is checked out in:</Trans>
            </p>
            <p
              className="mt-2 break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground/80"
              data-testid="share-receive-consent-path"
            >
              {seed.candidatePath}
            </p>
            {seed.parentProjectName !== null ? (
              <p
                className="mt-2 text-xs text-muted-foreground"
                data-testid="share-receive-consent-parent"
              >
                <Trans>(a worktree of {seed.parentProjectName})</Trans>
              </p>
            ) : null}
            <p className="mt-3 text-sm text-muted-foreground">
              <Trans>That folder isn't an OpenKnowledge project yet. Initialize it and open?</Trans>
            </p>
            {consentState.phase === 'error' ? (
              <p
                className="mt-3 text-sm text-destructive"
                data-testid="share-receive-consent-error"
                role="alert"
              >
                {consentState.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={handleConsentCancel}
              data-testid="share-receive-consent-cancel"
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              onClick={handleConsentInitialize}
              disabled={initializing || consentState.phase === 'error'}
              aria-disabled={initializing || consentState.phase === 'error'}
              data-testid="share-receive-consent-initialize"
            >
              {initializing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  <Trans>Initialize and open</Trans>
                </>
              ) : (
                <Trans>Initialize and open</Trans>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    );
  }

  if (!launcherMiss || !share || !expected) return null;

  // Clone is enabled regardless of auth: public repos clone anonymously, and a
  // private-repo failure routes the user to the sign-in affordance in the
  // banner below. Only an in-flight clone disables it.
  const cloneEnabled = cloneController !== undefined && !cloneRunning;
  const cloneLabel = cloneRunning ? t`Cloning...` : t`Clone to a new folder`;

  const lookingForUrl = canonicalGitHubRemoteUrl(expected);
  const signedInLogin = authStatus?.authenticated ? authStatus.login : undefined;
  // Condense raw git stderr to its meaningful line; empty when nothing useful
  // survives, in which case the dialog shows the cause list without an Error line.
  const cloneErrorMessage = cloneError?.detail ? formatCloneErrorMessage(cloneError.detail) : '';

  return (
    <DialogRoot
      open={true}
      onOpenChange={(open) => {
        if (!open) store.dismiss();
      }}
    >
      <DialogContent className="sm:max-w-xl" data-testid="share-receive-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Open shared {targetNoun}</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {share.owner}/{share.repo}
            {shareTargetPath(share.target) ? ` — ${shareTargetPath(share.target)}` : null}
          </DialogDescription>
          <ShareMetadataRows
            owner={share.owner}
            repo={share.repo}
            path={shareTargetPath(share.target)}
            kind={share.target.kind}
            branch={share.branch}
            testId="share-receive-metadata"
            branchTestId="share-receive-metadata-branch"
          />
        </DialogHeader>
        <DialogBody>
          {cloneError ? (
            // tabIndex -1 + ref so the focus effect can land focus here on
            // failure. `role="alert"` is scoped to the heading below (not this
            // whole block) so AT announces the one-line cause, not a wall of text.
            <div
              ref={cloneErrorRef}
              tabIndex={-1}
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 outline-none"
              data-testid="share-receive-clone-error"
            >
              <p className="text-sm font-semibold text-foreground" role="alert">
                <Trans>We couldn't clone this repository.</Trans>
              </p>
              {cloneErrorMessage ? (
                <p
                  className="mt-2 break-words text-xs text-destructive"
                  data-testid="share-receive-clone-error-message"
                >
                  <Trans>Error:</Trans>{' '}
                  <span className="font-mono text-foreground/80">"{cloneErrorMessage}"</span>
                </p>
              ) : null}
              <p className="mt-3 text-sm text-muted-foreground">
                <Trans>This usually means one of:</Trans>
              </p>
              <ul
                className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground"
                data-testid="share-receive-clone-error-reasons"
              >
                <li>
                  <Trans>
                    The repository is private and your GitHub account doesn't have access to it.
                  </Trans>
                </li>
                <li>
                  <Trans>The repository was moved, renamed, or deleted.</Trans>
                </li>
                <li>
                  <Trans>A network problem or GitHub outage interrupted the clone.</Trans>
                </li>
              </ul>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    void handleCloneCtaClick();
                  }}
                  data-testid="share-receive-clone-retry"
                >
                  {/* No in-place loading state: handleCloneCtaClick clears
                      cloneError, so this view unmounts and the card grid's
                      "Cloning..." button shows progress instead. */}
                  <Trans>Try again</Trans>
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    void handleLocalCtaClick();
                  }}
                  disabled={pickerOpen || cloneRunning}
                  data-testid="share-receive-error-local"
                >
                  <Trans>I already have it locally</Trans>
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                data-testid="share-receive-clone"
                className="flex flex-col items-start gap-2 rounded-lg border-2 border-primary/40 bg-card p-4 text-left transition hover:border-primary hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-primary/40 disabled:hover:bg-card"
                onClick={() => {
                  void handleCloneCtaClick();
                }}
                disabled={cloneController !== undefined && !cloneEnabled}
                aria-disabled={cloneController !== undefined && !cloneEnabled}
              >
                <span className="text-sm font-semibold">{cloneLabel}</span>
                <span className="line-clamp-2 text-1sm text-muted-foreground">
                  <Trans>Downloads a fresh copy from GitHub.</Trans>
                </span>
              </button>
              <button
                type="button"
                data-testid="share-receive-local"
                className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left transition hover:border-foreground/50 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  void handleLocalCtaClick();
                }}
                disabled={pickerOpen || cloneRunning}
              >
                <span className="text-sm font-semibold">
                  <Trans>I already have it locally →</Trans>
                </span>
                <span className="line-clamp-2 text-1sm text-muted-foreground">
                  <Trans>Pick the folder where you've cloned it.</Trans>
                </span>
              </button>
            </div>
          )}
          {cloneController ? (
            <div
              className="mt-3 flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
              data-testid="share-receive-auth-banner"
              role="status"
              aria-live="polite"
            >
              {authStatus === null ? (
                <span className="text-muted-foreground">
                  <Trans>Checking GitHub connection...</Trans>
                </span>
              ) : authStatus.authenticated ? (
                <span className="text-muted-foreground">
                  <Trans>
                    Connected as{' '}
                    <span className="font-medium text-foreground/90">@{signedInLogin}</span>
                  </Trans>
                </span>
              ) : (
                <>
                  <span className="text-muted-foreground">
                    <Trans>Not connected to GitHub.</Trans>
                  </span>
                  <button
                    type="button"
                    data-testid="share-receive-signin"
                    className="font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    onClick={() => {
                      void handleSignInClick();
                    }}
                    disabled={authChecking}
                  >
                    {authChecking ? <Trans>Opening...</Trans> : <Trans>Connect GitHub</Trans>}
                  </button>
                </>
              )}
            </div>
          ) : null}
          {cloneError ? null : (
            <p className="mt-3 text-1sm text-muted-foreground">
              <Trans>
                Looking for{' '}
                <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/80">
                  {lookingForUrl}
                </code>
                .
              </Trans>
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" className="font-mono uppercase" onClick={() => store.dismiss()}>
            <Trans>Cancel</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
