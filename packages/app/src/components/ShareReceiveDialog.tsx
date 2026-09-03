// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — Q2 card grid uses raw <button> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { classifyBranchMatch } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
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

export type ShareReceiveCloneResult =
  | { readonly kind: 'ok'; readonly dir: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly detail?: string };

export interface ShareReceiveCloneController {
  getAuthStatus(host?: string): Promise<OkLocalOpAuthStatusResponse>;
  startSignIn(): Promise<OkLocalOpAuthStatusResponse | null>;
  runClone(args: { url: string; branch?: string | null }): Promise<ShareReceiveCloneResult>;
}

export interface ShareReceiveDialogProps {
  bridge: OkDesktopBridge;
  cloneController?: ShareReceiveCloneController;
  store?: ShareReceiveStore;
}

type LauncherConsentPayload = Extract<OkShareReceivedPayload, { kind: 'launcher-consent' }>;
type LauncherMissPayload = Extract<OkShareReceivedPayload, { kind: 'launcher-miss' }>;

function pendingTarget(share: LauncherMissPayload['share'] | LauncherConsentPayload['share']) {
  return {
    kind: share.target.kind,
    path: shareTargetPath(share.target),
    repositoryPath: shareTargetPath(share.repositoryTarget),
    ...(share.contentRootDepth === null ? {} : { contentRootDepth: share.contentRootDepth }),
  };
}

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

export function ShareReceiveDialog({
  bridge,
  cloneController,
  store = shareReceiveStore,
}: ShareReceiveDialogProps) {
  const payload = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);

  const [remountKey, setRemountKey] = useState(0);
  const [seenPayload, setSeenPayload] = useState<OkShareReceivedPayload | null>(payload);
  if (payload !== seenPayload) {
    setSeenPayload(payload);
    setRemountKey((k) => k + 1);
  }

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
  const [cloneError, setCloneError] = useState<{ detail: string | null } | null>(null);
  const [consentState, setConsentState] = useState<ConsentFlowState | null>(null);
  const authProbeStartedRef = useRef(false);
  const cloneErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (cloneError) cloneErrorRef.current?.focus();
  }, [cloneError]);

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
        repositoryPath: shareTargetPath(payload.share.repositoryTarget),
        ...(payload.share.contentRootDepth === null
          ? {}
          : { contentRootDepth: payload.share.contentRootDepth }),
        parentProjectName: payload.parentProjectName,
      }),
    );
  }, [payload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cloneController identity churns every render; we want this gated on payload + auth-state transitions only.
  useEffect(() => {
    if (!cloneController) return;
    if (!isLauncherMissPayload(payload)) return;
    if (authStatus !== null) return;
    if (authProbeStartedRef.current) return;
    authProbeStartedRef.current = true;
    setAuthChecking(true);
    const shareHost = payload.share.host;
    void cloneController
      .getAuthStatus(shareHost)
      .then((result) => {
        setAuthStatus(result);
      })
      .catch((err) => {
        console.warn(
          '[receive] auth pre-flight probe failed',
          err instanceof Error ? err.message : err,
        );
        setAuthStatus({ authenticated: false, host: shareHost });
      })
      .finally(() => {
        setAuthChecking(false);
      });
  }, [payload, authStatus]);

  const launcherMiss = isLauncherMissPayload(payload) ? payload : null;
  const launcherConsent = isLauncherConsentPayload(payload) ? payload : null;
  const share = launcherMiss?.share ?? launcherConsent?.share ?? null;
  const expected = share ? { host: share.host, owner: share.owner, repo: share.repo } : null;
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
    if (cloneRunning) return;
    setCloneError(null);
    setCloneRunning(true);
    const cloneUrl = buildCloneUrl(expected);
    let result: ShareReceiveCloneResult;
    try {
      result = await cloneController.runClone({ url: cloneUrl, branch: launcherMiss.share.branch });
    } catch (err) {
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
          pendingDeepLinkTarget: pendingTarget(launcherMiss.share),
        });
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
  }

  async function handleSignInClick(): Promise<void> {
    if (!cloneController || authChecking) return;
    setAuthChecking(true);
    try {
      const next = await cloneController.startSignIn();
      setAuthChecking(false);
      if (next !== null) setAuthStatus(next);
    } catch (err) {
      setAuthChecking(false);
      console.warn('[receive] startSignIn failed', err instanceof Error ? err.message : err);
      toast.error(t`Could not open GitHub sign-in. Please try again.`);
    }
  }

  async function handleLocalCtaClick(): Promise<void> {
    if (!launcherMiss || !expected || pickerOpen) return;
    setCloneError(null);
    setPickerOpen(true);
    console.log(formatReceiveLog({ q2_path: 'local' }));
    try {
      while (true) {
        const folderPath = await bridge.dialog.openFolder();
        if (!folderPath) break;
        const result = await bridge.share.validateLocalFolder({
          folderPath,
          host: expected.host,
          owner: expected.owner,
          repo: expected.repo,
        });
        console.log(formatReceiveLog({ folder_validate: result.kind }));
        if (result.kind === 'ok') {
          const shareBranch = launcherMiss.share.branch;
          let head: HeadBranchInfo = { currentBranch: null, headSha: null, detached: false };
          try {
            head = await bridge.project.readHeadBranch(folderPath);
          } catch (err) {
            console.warn(
              '[receive] local-folder readHeadBranch failed',
              err instanceof Error ? err.message : err,
            );
          }
          const needsBranchSwitch = classifyBranchMatch(shareBranch, head) !== 'true';
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
                    pendingDeepLinkTarget: pendingTarget(launcherMiss.share),
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
              pendingDeepLinkTarget: {
                kind: seed.targetKind,
                path: seed.targetPath,
                repositoryPath: seed.repositoryPath ?? seed.targetPath,
                ...(seed.contentRootDepth === undefined
                  ? {}
                  : { contentRootDepth: seed.contentRootDepth }),
              },
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
                  <Spinner className="mr-2 h-4 w-4" aria-hidden="true" />
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

  const cloneEnabled = cloneController !== undefined && !cloneRunning;
  const cloneLabel = cloneRunning ? t`Cloning...` : t`Clone to a new folder`;

  const lookingForUrl = canonicalGitHubRemoteUrl(expected);
  const signedInLogin = authStatus?.authenticated ? authStatus.login : undefined;
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
                  {}
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
                className="flex flex-col items-start gap-2 rounded-lg border border-primary/50 bg-primary/5 p-4 text-left transition hover:border-primary hover:bg-primary/10 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-primary/50 disabled:hover:bg-primary/5"
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
                className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left transition hover:border-foreground/50 hover:bg-accent focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
          <Button variant="outline" onClick={() => store.dismiss()}>
            <Trans>Cancel</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
