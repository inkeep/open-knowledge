/**
 * PublishToGitHubDialog — wizard that publishes a no-remote project to
 * GitHub. Mounted by the editor surface in response to the Share
 * button's no-remote callback (through an explicit modal).
 *
 * Flow (one-pass linear; no separate "step" state machine):
 *
 *   1. On open, fetch owners → rendered as a radio list, with the first org
 *      pre-selected when the user belongs to one (else their own account).
 *   2. Name field pre-fills with `sanitizeRepoName(extractFolderBasename(contentDir))`.
 *      User-edited values re-sanitize inline; "Will be created as `<name>`"
 *      preview reflects the sanitized form.
 *   3. Name-check fires 500ms after the last keystroke (or immediately on
 *      blur) and renders an inline ✓/✗ status next to the field.
 *   4. Submit is enabled iff owner + sanitized-name + name-check === available.
 *   5. POST /api/share/publish; on `{ok:true}` transition the dialog to a
 *      "Published" success view that exposes an explicit "Copy share link"
 *      button. Clicking it installs a fresh user gesture that the shared
 *      `runShareAction` orchestrator + clipboard adapter ride to satisfy the
 *      browser Clipboard API's transient-activation gate. (Auto-copying
 *      inside `handleSubmit` is impossible in browsers: the multi-second
 *      publish submit consumes the original click's activation.)
 *   6. Each error code maps to a banner via `presentPublishError`:
 *      `name-conflict`/`saml-sso`/`push-failed`/`auth-required`/etc.
 *
 * If the GET /api/share/publish/owners endpoint returns `auth-required`
 * (no token in the keychain), the wizard mounts the existing `AuthModal`
 * Device Flow surface; on success it retries the owners fetch automatically.
 */

import type { SharePublishOwner } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { CheckCircle2, Copy, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AuthModal } from '@/components/AuthModal';
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
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { useDocumentContext } from '@/editor/DocumentContext';
import { docNameToMarkdownPath } from '@/lib/doc-paths';
import { isPermissionsPolicyRefusal, scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import {
  canSubmitPublish,
  extractFolderBasename,
  fetchPublishNameCheck,
  fetchPublishOwners,
  type NameCheckStatus,
  pickDefaultOwner,
  presentPublishError,
  resolveNameCheckStatus,
  sanitizeRepoName,
  submitPublishRequest,
} from '@/lib/share/publish-wizard';
import { mapShareErrorToToast, requestShareConstructUrl } from '@/lib/share/run-share-action';
import { useWorkspace } from '@/lib/use-workspace';

const NAME_CHECK_DEBOUNCE_MS = 500;

export interface PublishToGitHubDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PublishToGitHubDialog({ open, onOpenChange }: PublishToGitHubDialogProps) {
  const { t } = useLingui();
  const workspace = useWorkspace();
  const { activeDocName } = useDocumentContext();

  const [owners, setOwners] = useState<SharePublishOwner[] | null>(null);
  const [ownersLoading, setOwnersLoading] = useState(false);
  const [ownersError, setOwnersError] = useState<string | null>(null);
  const [selectedOwner, setSelectedOwner] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [description, setDescription] = useState<string>('');
  const [nameCheck, setNameCheck] = useState<NameCheckStatus>({ kind: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<{
    message: string;
    next: ReturnType<typeof presentPublishError>['next'];
  } | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  // After publish succeeds we transition the modal to a success state with
  // an explicit "Copy share link" button instead of auto-copying. Reasons:
  //
  //   1. The browser Clipboard API requires the write call to occur inside
  //      a fresh user gesture's transient activation; the multi-second
  //      publish submit above consumed the original click's activation, so
  //      any auto-copy attempt fires outside the activation window and is
  //      rejected by the underlying browser API.
  //   2. Even with a fresh click, browser deployments inside an iframe
  //      (e.g. the Claude preview tool) may have `clipboard-write`
  //      Permissions Policy disabled, in which case the browser refuses
  //      the write instantly regardless of activation.
  //
  // Defense: we eagerly fetch the share URL when the success view mounts
  // and render it as a selectable readonly input. The Copy button click
  // is then SYNCHRONOUS (no async work between click and clipboard call),
  // and if the browser still refuses (iframe policy, etc.) the URL is
  // right there for the user to select and copy manually.
  const [publishResult, setPublishResult] = useState<{
    ownerLogin: string;
    repoName: string;
  } | null>(null);
  const [copying, setCopying] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareUrlError, setShareUrlError] = useState<string | null>(null);

  // Debounce timer for name-check; cleared on every keystroke and on unmount.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightNameRef = useRef<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const sanitizedName = sanitizeRepoName(name);
  const selectedOwnerEntry = owners?.find((o) => o.login === selectedOwner) ?? null;

  async function loadOwners() {
    setOwnersLoading(true);
    setOwnersError(null);
    try {
      const res = await fetchPublishOwners();
      if (!res.ok) {
        if (res.error === 'auth-required') {
          setAuthOpen(true);
          setOwnersError(t`Connect GitHub to continue.`);
        } else {
          setOwnersError(t`Couldn't reach GitHub. Try again?`);
        }
        setOwnersLoading(false);
        return;
      }
      setOwners(res.owners);
      if (res.owners.length > 0 && selectedOwner === '') {
        setSelectedOwner(pickDefaultOwner(res.owners));
      }
    } catch {
      setOwnersError(t`Couldn't reach GitHub. Try again?`);
    }
    setOwnersLoading(false);
  }

  // Reset transient state + seed name on every open (the open-tracking
  // useEffect pattern from CreateProjectDialog). Without this, a previous
  // session's banner / busy / typed name / post-publish success view would
  // persist across opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open-effect — workspace pulled lazily
  useEffect(() => {
    if (!open) return;
    setNameCheck({ kind: 'idle' });
    setBanner(null);
    setSubmitting(false);
    setOwnersError(null);
    setPublishResult(null);
    setCopying(false);
    setShareUrl(null);
    setShareUrlError(null);
    const seededName = sanitizeRepoName(extractFolderBasename(workspace?.contentDir ?? ''));
    setName(seededName);
    setVisibility('private');
    setDescription('');
    if (owners === null) {
      void loadOwners();
    } else if (selectedOwner === '' && owners.length > 0) {
      setSelectedOwner(pickDefaultOwner(owners));
    }
  }, [open]);

  // Name-check: debounce, fire, route. Skips if the sanitized name is
  // empty, the owner isn't yet known, or we already have a result for
  // this exact (owner, name) pair.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);

    if (selectedOwner === '' || sanitizedName === '') {
      setNameCheck({ kind: 'idle' });
      return;
    }

    setNameCheck({ kind: 'pending' });

    debounceRef.current = setTimeout(async () => {
      const owner = selectedOwner;
      const candidate = sanitizedName;
      inFlightNameRef.current = `${owner}|${candidate}`;
      setNameCheck({ kind: 'checking' });
      try {
        const res = await fetchPublishNameCheck(owner, candidate);
        if (inFlightNameRef.current !== `${owner}|${candidate}`) return;
        setNameCheck(resolveNameCheckStatus(res, owner, candidate));
      } catch {
        if (inFlightNameRef.current !== `${owner}|${candidate}`) return;
        setNameCheck({ kind: 'error', banner: t`Couldn't reach GitHub. Try again?` });
      }
    }, NAME_CHECK_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [open, selectedOwner, sanitizedName, t]);

  // Eagerly fetch the share URL once the dialog has transitioned to the
  // success view. The user's click on "Copy share link" is then purely
  // synchronous — the underlying clipboard write fires inside the same JS
  // task as the click, with no awaits in between. This preserves the
  // freshest possible transient activation. The fetched URL also gets
  // rendered as a selectable input so the user has a manual fallback when
  // the browser refuses the clipboard write outright (iframe Permissions
  // Policy, denied permission, etc.).
  useEffect(() => {
    if (!publishResult || !activeDocName) return;
    let cancelled = false;
    void (async () => {
      try {
        const docPath = docNameToMarkdownPath(activeDocName);
        const response = await requestShareConstructUrl({ kind: 'doc', docPath });
        if (cancelled) return;
        if (response.ok) {
          setShareUrl(response.shareUrl);
        } else {
          setShareUrlError(mapShareErrorToToast(response.error, response.branch));
        }
      } catch (error) {
        if (cancelled) return;
        // Log the underlying transport / parse error for future debugging
        // — the inline `shareUrlError` text shown in the dialog is the
        // user-facing message; the console payload is the diagnostic one.
        console.warn('[share] action=prefetch-share-url result=failed', error);
        setShareUrlError(t`Couldn't construct the share URL. Try Done and re-share.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publishResult, activeDocName, t]);

  function handleAuthSuccess() {
    setAuthOpen(false);
    setOwnersError(null);
    void loadOwners();
  }

  async function handleSubmit() {
    if (!canSubmitPublish({ owner: selectedOwnerEntry, sanitizedName, nameCheck, submitting })) {
      return;
    }
    setSubmitting(true);
    setBanner(null);
    try {
      const res = await submitPublishRequest({
        owner: selectedOwner,
        name: sanitizedName,
        visibility,
        description: description.trim().length > 0 ? description.trim() : undefined,
      });
      if (res.ok) {
        // Transition to the success view. Don't auto-copy — the user gesture
        // that started `handleSubmit` was consumed by the multi-second publish
        // submit, so `navigator.clipboard.write` would reject. The success
        // view's "Copy share link" button installs a fresh activation.
        setPublishResult({ ownerLogin: res.ownerLogin, repoName: res.repoName });
        setSubmitting(false);
        return;
      }
      const presentation = presentPublishError(res.error, selectedOwner, sanitizedName);
      setBanner({ message: presentation.banner, next: presentation.next });
      if (presentation.next.kind === 'edit-name') {
        nameInputRef.current?.focus();
        nameInputRef.current?.select();
      } else if (presentation.next.kind === 'reauth') {
        setAuthOpen(true);
      }
    } catch {
      setBanner({
        message: t`Couldn't reach GitHub. Try again?`,
        next: { kind: 'edit-form' },
      });
    }
    setSubmitting(false);
  }

  function handleCopyShareLink() {
    if (!shareUrl || copying) return;
    // Fire the clipboard write SYNCHRONOUSLY inside the click handler — the
    // URL is already in state, so there's no async work between click and
    // the underlying writeText / IPC call. Maximizes the activation budget.
    // We use a then/catch chain (not await) so the call site stays sync
    // through entry; the `setCopying(false)` happens in `finally`.
    setCopying(true);
    scheduleClipboardWrite(shareUrl)
      .then(() => {
        toast.success(t`Link copied.`);
        onOpenChange(false);
      })
      .catch((error: unknown) => {
        console.warn('[share] action=link-construct result=clipboard-failed', error);
        if (isPermissionsPolicyRefusal(error) && window.self !== window.top) {
          // Embedded inside a parent frame (e.g. a preview tool) whose
          // Permissions-Policy doesn't include `clipboard-write`. No
          // amount of activation hygiene can rescue this from inside the
          // iframe — the parent has to grant the permission. Point the
          // user at the desktop app and the manual fallback.
          toast.error(
            t`Preview browsers can't auto-copy. Use Cmd/Ctrl+C on the URL above, or open OK in the desktop app.`,
          );
          return;
        }
        toast.error(t`Couldn't copy. Select the URL above to copy it manually.`);
      })
      .finally(() => {
        setCopying(false);
      });
  }

  function handleAuthorizeInBrowser(authorizeUrl: string) {
    const opener = window.okDesktop?.shell?.openExternal;
    if (opener) {
      void opener(authorizeUrl);
    } else {
      window.open(authorizeUrl, '_blank', 'noopener');
    }
  }

  function handleClose() {
    onOpenChange(false);
  }

  const submitDisabled = !canSubmitPublish({
    owner: selectedOwnerEntry,
    sanitizedName,
    nameCheck,
    submitting,
  });

  return (
    <>
      <DialogRoot open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          {publishResult ? (
            <PublishSuccessView
              ownerLogin={publishResult.ownerLogin}
              repoName={publishResult.repoName}
              shareUrl={shareUrl}
              shareUrlError={shareUrlError}
              copying={copying}
              canCopy={activeDocName !== null}
              onCopy={handleCopyShareLink}
              onClose={handleClose}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  <Trans>Publish to GitHub</Trans>
                </DialogTitle>
                <DialogDescription>
                  <Trans>
                    Sharing a doc needs a GitHub repository. Create one for this project.
                  </Trans>
                </DialogDescription>
              </DialogHeader>

              <DialogBody className="flex flex-col gap-6">
                <fieldset className="flex flex-col gap-2">
                  <Label id="publish-owner-label">
                    <Trans>Owner</Trans>
                  </Label>
                  {ownersLoading && owners === null ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />{' '}
                      <Trans>Loading...</Trans>
                    </div>
                  ) : ownersError ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-destructive">{ownersError}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => loadOwners()}
                      >
                        <Trans>Retry</Trans>
                      </Button>
                    </div>
                  ) : (
                    <RadioGroup
                      value={selectedOwner}
                      onValueChange={setSelectedOwner}
                      aria-labelledby="publish-owner-label"
                      data-testid="publish-owner-radio"
                    >
                      {(owners ?? []).map((o) => {
                        const itemId = `publish-owner-${o.login}`;
                        return (
                          <FieldLabel key={o.login} htmlFor={itemId}>
                            <Field orientation="horizontal">
                              <FieldContent>
                                <FieldTitle>
                                  {o.avatarUrl ? (
                                    <img
                                      src={o.avatarUrl}
                                      alt=""
                                      aria-hidden
                                      className="size-4 rounded-full"
                                    />
                                  ) : null}
                                  <span>{o.login}</span>
                                </FieldTitle>
                              </FieldContent>
                              <RadioGroupItem
                                value={o.login}
                                id={itemId}
                                data-testid={`publish-owner-option-${o.login}`}
                              />
                            </Field>
                          </FieldLabel>
                        );
                      })}
                    </RadioGroup>
                  )}
                </fieldset>

                <fieldset className="flex flex-col gap-2">
                  <Label htmlFor="publish-name">
                    <Trans>Repository name</Trans>
                  </Label>
                  <Input
                    id="publish-name"
                    ref={nameInputRef}
                    data-testid="publish-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => {
                      // Trigger an immediate name-check by resetting the
                      // in-flight key — the existing effect already covers
                      // the debounced path, this just closes the gap when
                      // a user tabs out fast.
                      inFlightNameRef.current = null;
                    }}
                    placeholder="my-knowledge-base"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div
                    className="flex items-center justify-between gap-3 text-1sm"
                    aria-live="polite"
                  >
                    <span className="text-muted-foreground">
                      {sanitizedName ? (
                        <Trans>
                          Will be created as <code className="font-mono">{sanitizedName}</code>
                        </Trans>
                      ) : (
                        <Trans>Pick a name</Trans>
                      )}
                    </span>
                    <NameCheckIndicator status={nameCheck} />
                  </div>
                </fieldset>

                <fieldset className="flex flex-col gap-2">
                  <Label id="publish-visibility-label">
                    <Trans>Visibility</Trans>
                  </Label>
                  <RadioGroup
                    value={visibility}
                    onValueChange={(value: string) =>
                      setVisibility(value === 'public' ? 'public' : 'private')
                    }
                    className="sm:flex"
                    aria-labelledby="publish-visibility-label"
                  >
                    <FieldLabel htmlFor="publish-visibility-private">
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldTitle>
                            <Trans>Private</Trans>
                          </FieldTitle>
                          <FieldDescription className="text-1sm">
                            <Trans>Only collaborators</Trans>
                          </FieldDescription>
                        </FieldContent>
                        <RadioGroupItem
                          value="private"
                          id="publish-visibility-private"
                          data-testid="publish-visibility-private"
                        />
                      </Field>
                    </FieldLabel>
                    <FieldLabel htmlFor="publish-visibility-public">
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldTitle>
                            <Trans>Public</Trans>
                          </FieldTitle>
                          <FieldDescription className="text-1sm">
                            <Trans>Anyone can see</Trans>
                          </FieldDescription>
                        </FieldContent>
                        <RadioGroupItem
                          value="public"
                          id="publish-visibility-public"
                          data-testid="publish-visibility-public"
                        />
                      </Field>
                    </FieldLabel>
                  </RadioGroup>
                </fieldset>

                <fieldset className="flex flex-col gap-2">
                  <Label htmlFor="publish-description">
                    <Trans>Description (optional)</Trans>
                  </Label>
                  <Textarea
                    id="publish-description"
                    data-testid="publish-description"
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t`What is this knowledge base for?`}
                  />
                </fieldset>

                {banner && (
                  <PublishBanner
                    banner={banner}
                    onAuthorize={handleAuthorizeInBrowser}
                    onRetryPush={handleSubmit}
                  />
                )}
              </DialogBody>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="font-mono uppercase"
                  onClick={handleClose}
                >
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={submitDisabled}
                  data-testid="publish-submit"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />{' '}
                      <Trans>Publishing...</Trans>
                    </>
                  ) : (
                    <Trans>Publish</Trans>
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </DialogRoot>

      <AuthModal open={authOpen} onOpenChange={setAuthOpen} onSuccess={handleAuthSuccess} />
    </>
  );
}

function PublishSuccessView({
  ownerLogin,
  repoName,
  shareUrl,
  shareUrlError,
  copying,
  canCopy,
  onCopy,
  onClose,
}: {
  ownerLogin: string;
  repoName: string;
  shareUrl: string | null;
  shareUrlError: string | null;
  copying: boolean;
  canCopy: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  // Once the URL lands, pre-select it so a keyboard cmd/ctrl+C copies it
  // without needing the Copy button. Cheap belt-and-braces against any
  // environment that refuses the programmatic clipboard write.
  useEffect(() => {
    if (!shareUrl || !urlInputRef.current) return;
    urlInputRef.current.focus();
    urlInputRef.current.select();
  }, [shareUrl]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <Trans>Published</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            Your knowledge base is now on GitHub at{' '}
            <code className="font-mono">
              {ownerLogin}/{repoName}
            </code>
            .
          </Trans>
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <div
          role="status"
          data-testid="publish-success"
          className="flex items-start gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm"
        >
          <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" aria-hidden />
          <span className="text-foreground">
            {canCopy ? (
              <Trans>Your share link is ready below.</Trans>
            ) : (
              <Trans>Open a doc to share its URL.</Trans>
            )}
          </span>
        </div>
        {canCopy && (
          <fieldset className="flex flex-col gap-2">
            <Label htmlFor="publish-share-url">
              <Trans>Share URL</Trans>
            </Label>
            {shareUrlError ? (
              <div
                role="alert"
                data-testid="publish-share-url-error"
                className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-sm text-destructive"
              >
                {shareUrlError}
              </div>
            ) : shareUrl ? (
              <Input
                id="publish-share-url"
                ref={urlInputRef}
                data-testid="publish-share-url"
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.currentTarget.select()}
                // Right-click must land with the URL selected so any native
                // context menu the host provides offers an enabled Copy.
                onContextMenu={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
            ) : (
              <div
                data-testid="publish-share-url-loading"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden />{' '}
                <Trans>Preparing share URL...</Trans>
              </div>
            )}
          </fieldset>
        )}
      </DialogBody>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          className="font-mono uppercase"
          onClick={onClose}
          data-testid="publish-success-done"
        >
          <Trans>Done</Trans>
        </Button>
        {canCopy && (
          <Button
            type="button"
            onClick={onCopy}
            disabled={copying || !shareUrl}
            data-testid="publish-copy-link"
            aria-label={t`Copy share link`}
          >
            {copying ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> <Trans>Copying...</Trans>
              </>
            ) : (
              <>
                <Copy className="size-3.5" aria-hidden /> <Trans>Copy share link</Trans>
              </>
            )}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function PublishBanner({
  banner,
  onAuthorize,
  onRetryPush,
}: {
  banner: {
    message: string;
    next: ReturnType<typeof presentPublishError>['next'];
  };
  onAuthorize: (url: string) => void;
  onRetryPush: () => void;
}) {
  const next = banner.next;
  return (
    <div
      role="alert"
      data-testid="publish-banner"
      className="flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm"
    >
      <span>{banner.message}</span>
      {next.kind === 'authorize-org' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="publish-authorize-org"
          onClick={() => onAuthorize(next.authorizeUrl)}
        >
          <Trans>Authorize in browser</Trans> <ExternalLink className="ml-1 size-3" aria-hidden />
        </Button>
      )}
      {next.kind === 'retry-push' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="publish-retry-push"
          onClick={onRetryPush}
        >
          <Trans>Retry push</Trans>
        </Button>
      )}
    </div>
  );
}

function NameCheckIndicator({ status }: { status: NameCheckStatus }) {
  if (status.kind === 'available') {
    return (
      <span
        data-testid="publish-name-check"
        data-status="available"
        className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"
      >
        <CheckCircle2 className="size-3.5" aria-hidden /> <Trans>Available</Trans>
      </span>
    );
  }
  if (status.kind === 'taken') {
    const { owner, name } = status;
    return (
      <span
        data-testid="publish-name-check"
        data-status="taken"
        className="flex items-center gap-1 text-destructive"
      >
        <XCircle className="size-3.5" aria-hidden />{' '}
        <Trans>
          {owner}/{name} already exists
        </Trans>
      </span>
    );
  }
  if (status.kind === 'checking' || status.kind === 'pending') {
    return (
      <span
        data-testid="publish-name-check"
        data-status={status.kind}
        className="flex items-center gap-1 text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> <Trans>Checking...</Trans>
      </span>
    );
  }
  if (status.kind === 'error') {
    return (
      <span data-testid="publish-name-check" data-status="error" className="text-destructive">
        {status.banner}
      </span>
    );
  }
  return null;
}
